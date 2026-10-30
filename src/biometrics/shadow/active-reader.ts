import type Database from 'better-sqlite3'
import { z } from 'zod'
import { biometricManifest, manifestHash, validateConfig } from '../algorithms/registry'
import { configHash, dataHash } from '../algorithms/canonical'
import { shadowActiveReadingSchema } from './worker-sink'
import { firmwareTimestampBasis } from './worker-protocol'
import { MECHANICAL_CONTEXT_VERSION } from '../mechanical/context'
import { mechanicalWindowProof } from '../mechanical/proof'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const optionsSchema = z.object({ side: z.enum(['left', 'right']), startMs: integer, endMs: integer,
  activeConfigHash: z.string().regex(/^[a-f0-9]{64}$/), maximumRows: integer.min(1).max(100) }).strict()
const rowSchema = z.object({ id: integer.positive(), side: z.enum(['left', 'right']), timestamp: integer,
  heart_rate: z.number().finite().nullable(), hrv: z.number().finite().nullable(), breathing_rate: z.number().finite().nullable(),
  processing_run_id: z.string().uuid(), run_side: z.enum(['left', 'right']), kind: z.literal('live'),
  config_hash: z.string(), bundle: z.string(), input_identity: z.string(), started_at_ms: integer, ended_at_ms: integer.nullable(),
  quality_count: z.literal(1), quality_score: z.number().min(0).max(1), quality_side: z.enum(['left', 'right']), quality_timestamp: integer,
  quality_flags: z.string().max(8192),
})
const bundleSchema = z.object({ schemaVersion: z.literal(1), manifestHash: z.string(), resolved: z.unknown(),
  generation: integer, revisionId: z.string().uuid().nullable(), components: z.unknown(), sourceHashes: z.unknown() }).strict()
const inputSchema = z.object({ sourceSide: z.enum(['left', 'right']), timestampBasis: z.literal(firmwareTimestampBasis),
  rawIdentity: z.literal('not_retained'), sensorCalibration: z.literal('not_consumed'),
  mechanicalContext: z.literal(MECHANICAL_CONTEXT_VERSION) }).strict()

/** Poll an already-open read-only connection. Only observations inserted after
 * construction are eligible; historical rows are never replayed as live output.
 * The caller controls cadence and must fail its attempt on any reader error. */
export class ShadowActiveReader {
  private readonly options: z.infer<typeof optionsSchema>
  private cursor: number
  private anchorHash: string | null

  constructor(private readonly db: Database.Database, options: unknown, private readonly now = Date.now) {
    this.options = optionsSchema.parse(options)
    if (this.options.startMs >= this.options.endMs || this.options.endMs - this.options.startMs > 7 * 86400000) throw new Error('Invalid active observation window')
    if (!db.readonly && db.pragma('query_only', { simple: true }) !== 1) throw new Error('Active capture requires a read-only connection')
    const anchor = this.latest()
    this.cursor = anchor?.id ?? 0
    this.anchorHash = anchor ? dataHash(anchor) : null
  }

  private latest() {
    const row = this.db.prepare('SELECT id, side, timestamp, heart_rate, hrv, breathing_rate, processing_run_id FROM vitals ORDER BY id DESC LIMIT 1')
      .get() as { id: number } | undefined
    if (row) integer.positive().parse(row.id)
    return row
  }

  poll() {
    return this.db.transaction(() => {
      if (this.cursor) {
        const anchor = this.db.prepare('SELECT id, side, timestamp, heart_rate, hrv, breathing_rate, processing_run_id FROM vitals WHERE id = ?').get(this.cursor)
        if (!anchor || dataHash(anchor) !== this.anchorHash) throw new Error('Active observation cursor changed or was removed')
      }
      const latest = this.latest()
      if (!latest || latest.id < this.cursor) {
        if (this.cursor) throw new Error('Active observations reset')
        return []
      }
      const { side, startMs, endMs, maximumRows, activeConfigHash } = this.options
      const rows = this.db.prepare(`SELECT v.*, r.side AS run_side, r.kind, r.config_hash,
        CASE WHEN length(CAST(r.bundle AS BLOB)) <= 65536 THEN r.bundle END AS bundle,
        CASE WHEN length(CAST(r.input_identity AS BLOB)) <= 4096 THEN r.input_identity END AS input_identity,
        r.started_at_ms, r.ended_at_ms,
        (SELECT COUNT(*) FROM vitals_quality q WHERE q.vitals_id = v.id) AS quality_count,
        (SELECT quality_score FROM vitals_quality q WHERE q.vitals_id = v.id LIMIT 1) AS quality_score,
        (SELECT side FROM vitals_quality q WHERE q.vitals_id = v.id LIMIT 1) AS quality_side,
        (SELECT timestamp FROM vitals_quality q WHERE q.vitals_id = v.id LIMIT 1) AS quality_timestamp,
        (SELECT CASE WHEN length(CAST(flags AS BLOB)) <= 8192 THEN flags END FROM vitals_quality q WHERE q.vitals_id = v.id LIMIT 1) AS quality_flags
        FROM vitals v LEFT JOIN biometric_processing_runs r ON r.id = v.processing_run_id
        WHERE v.id > ? AND v.id <= ? AND v.side = ? AND v.timestamp >= ? AND v.timestamp < ?
        ORDER BY v.id LIMIT ?`).all(this.cursor, latest.id, side, Math.ceil(startMs / 1000), Math.ceil(endMs / 1000), maximumRows + 1)
      if (rows.length > maximumRows) throw new Error('Active observation poll quota exceeded')
      const at = this.now()
      const readings = rows.map((raw) => {
        const row = rowSchema.parse(raw), timestampMs = row.timestamp * 1000
        const bundle = bundleSchema.parse(JSON.parse(row.bundle)), input = inputSchema.parse(JSON.parse(row.input_identity))
        mechanicalWindowProof(JSON.parse(row.quality_flags), { timestampMs, heartRate: row.heart_rate, hrv: row.hrv, breathingRate: row.breathing_rate })
        validateConfig(bundle.resolved)
        if (!Number.isSafeInteger(timestampMs) || timestampMs > at || timestampMs + 999 < row.started_at_ms
          || (row.ended_at_ms !== null && timestampMs >= row.ended_at_ms)
          || row.side !== row.run_side || row.quality_side !== row.side || row.quality_timestamp !== row.timestamp
          || row.config_hash !== activeConfigHash || configHash(bundle.resolved) !== activeConfigHash
          || bundle.manifestHash !== manifestHash || configHash(bundle.components) !== configHash(biometricManifest.components)
          || configHash(bundle.sourceHashes) !== configHash(biometricManifest.sourceHashes)) throw new Error('Active observation provenance mismatch')
        return shadowActiveReadingSchema.parse({ side, timestampMs, configHash: activeConfigHash, inputHash: null,
          provenance: { processingRunId: row.processing_run_id, sourceSide: input.sourceSide, generation: bundle.generation, manifestHash: bundle.manifestHash, timestampBasis: input.timestampBasis },
          readings: [
            { metric: 'heart_rate', unit: 'bpm', windowMs: null, value: row.heart_rate, quality: row.quality_score },
            { metric: 'breathing_rate', unit: 'breaths/min', windowMs: null, value: row.breathing_rate, quality: row.quality_score },
            { metric: 'window_ibi_variability_v1', unit: 'ms', windowMs: 300000, value: row.hrv, quality: row.quality_score },
          ] })
      })
      // Advance only after the entire bounded snapshot validates. Unknown,
      // malformed or substituted provenance can never be skipped silently.
      this.cursor = latest.id
      this.anchorHash = dataHash(latest)
      return readings
    })()
  }
}
