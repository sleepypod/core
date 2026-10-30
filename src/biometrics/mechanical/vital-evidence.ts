import { z } from 'zod'
import { MECHANICAL_CONTEXT_VERSION } from './context'
import { mechanicalWindowProof } from './proof'

const inputSchema = z.object({ timestampBasis: z.literal('firmware_event_time_v1'),
  mechanicalContext: z.literal(MECHANICAL_CONTEXT_VERSION), sourceSide: z.enum(['left', 'right']) })
const vitalSchema = z.object({ side: z.enum(['left', 'right']), run_side: z.enum(['left', 'right']),
  timestamp: z.number().int().positive(), heart_rate: z.number().finite().nullable(),
  breathing_rate: z.number().finite().nullable(), hrv: z.number().finite().nullable(),
  quality_score: z.number().min(0).max(1), quality_count: z.literal(1),
  quality_side: z.enum(['left', 'right']), quality_timestamp: z.number().int(),
  flags: z.string().max(8192), input_identity: z.string().max(4096), kind: z.literal('live') })

export const VITAL_EVIDENCE_QUERY = `SELECT v.*, r.side AS run_side, r.kind,
        CASE WHEN length(CAST(r.input_identity AS BLOB)) <= 4096 THEN r.input_identity END AS input_identity,
        (SELECT COUNT(*) FROM (SELECT 1 FROM vitals_quality quality WHERE quality.vitals_id=v.id LIMIT 2)) AS quality_count,
        q.side AS quality_side, q.timestamp AS quality_timestamp, q.quality_score,
        CASE WHEN length(CAST(q.flags AS BLOB)) <= 8192 THEN q.flags END AS flags
        FROM vitals v JOIN biometric_processing_runs r ON r.id=v.processing_run_id
        JOIN vitals_quality q ON q.vitals_id=v.id`

/** Shared provenance validation; the caller supplies current or historical coverage. */
export function parseVitalEvidence(raw: unknown) {
  const row = vitalSchema.parse(raw)
  const input = inputSchema.parse(JSON.parse(row.input_identity))
  const timestampMs = row.timestamp * 1000
  if (!Number.isSafeInteger(timestampMs) || row.side !== row.run_side || row.side !== row.quality_side
    || row.timestamp !== row.quality_timestamp) throw new Error('Vital identity or timestamp mismatch')
  const flags = z.array(z.string().max(512)).max(64).parse(JSON.parse(row.flags))
  const proof = mechanicalWindowProof(flags, { timestampMs, heartRate: row.heart_rate, breathingRate: row.breathing_rate, hrv: row.hrv })
  return { row, input, timestampMs, flags, proof }
}
