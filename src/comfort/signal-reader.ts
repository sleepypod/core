import type Database from 'better-sqlite3'
import { setImmediate as yieldToControls } from 'node:timers/promises'
import { z } from 'zod'
import type { Side } from '@/src/hardware/types'
import { parseVitalEvidence, VITAL_EVIDENCE_QUERY } from '@/src/biometrics/mechanical/vital-evidence'
import { mechanicalSpanSchema, readMechanicalSnapshot } from '@/src/biometrics/mechanical/snapshot'
import { MECHANICAL_MAX_SPANS } from '@/src/biometrics/mechanical/context'
import { COMFORT_WINDOW_MS, HISTORY_DAY_MS, median, missingComfortSignals, personalBaseline, summarizeComfortSignals } from './signals'
import type { ComfortSignals, ComfortWindow, PersonalBaseline } from './signals'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identitySchema = z.object({ config_hash: hash, manifest_hash: hash, bundle_version: z.literal(1) })
const query = VITAL_EVIDENCE_QUERY.replace('SELECT v.*,', `SELECT v.*, r.config_hash,
  CASE WHEN length(CAST(r.bundle AS BLOB)) <= 65536 AND json_valid(r.bundle) THEN json_extract(r.bundle, '$.manifestHash') END AS manifest_hash,
  CASE WHEN length(CAST(r.bundle AS BLOB)) <= 65536 AND json_valid(r.bundle) THEN json_extract(r.bundle, '$.schemaVersion') END AS bundle_version,`)
type Span = z.infer<typeof mechanicalSpanSchema>
type Estimate = ReturnType<typeof estimate>

/** Keep source channel and numerical pipeline identity separate across restarts and routing changes. */
function estimate(raw: unknown) {
  const evidence = parseVitalEvidence(raw)
  const identity = identitySchema.parse(raw)
  if (evidence.row.heart_rate === null || evidence.row.heart_rate < 30 || evidence.row.heart_rate > 90
    || evidence.row.quality_score < 0.5 || evidence.flags.some(flag => !['no_hrv', 'no_br'].includes(flag) && !flag.startsWith('mechanical_context_v1:'))) {
    throw new Error('Heart-rate estimate outside the conservative comparison envelope')
  }
  return { ...evidence, heartRate: evidence.row.heart_rate,
    key: JSON.stringify([evidence.row.side, evidence.input.sourceSide, identity.config_hash, identity.manifest_hash]) }
}

function covered(value: Estimate, spans: Map<string, Span>, now: number): boolean {
  const span = spans.get(value.proof.spanId)
  return value.timestampMs <= now && value.proof.endMs <= now && !!span && span.epoch === value.proof.epoch
    && span.startMs <= value.proof.startMs && span.endMs >= value.proof.endMs
}

/** Five distinct minute estimates summarize a window; they are not continuous five-minute HR measurements. */
export function completeComfortWindows(rows: unknown[], key: string, spans: Map<string, Span>, now: number): ComfortWindow[] {
  const groups = new Map<number, Estimate[]>()
  for (const raw of rows) {
    try {
      const value = estimate(raw)
      if (value.key !== key || !covered(value, spans, now)) continue
      const start = Math.floor(value.timestampMs / COMFORT_WINDOW_MS) * COMFORT_WINDOW_MS
      const values = groups.get(start) ?? []
      values.push(value)
      groups.set(start, values)
    }
    catch { /* Missing provenance stays excluded; it is never repaired from current state. */ }
  }
  const windows: ComfortWindow[] = []
  for (const [start, values] of groups) {
    const end = start + COMFORT_WINDOW_MS
    values.sort((first, second) => first.timestampMs - second.timestampMs)
    const first = values[0], span = spans.get(first.proof.spanId)
    if (end > now || values.length !== 5 || new Set(values.map(value => Math.floor(value.timestampMs / 60_000))).size !== 5
      || values.some(value => value.proof.spanId !== first.proof.spanId || value.proof.epoch !== first.proof.epoch)
      || values.some((value, index) => index > 0 && (value.timestampMs - values[index - 1].timestampMs < 45_000 || value.timestampMs - values[index - 1].timestampMs > 75_000))
      || !span || span.startMs > start || span.endMs < end) continue
    windows.push({ start, end, heartRate: median(values.map(value => value.heartRate)), spanId: span.id, epoch: span.epoch,
      evidenceStart: Math.min(start, ...values.map(value => value.proof.startMs)), evidenceEnd: Math.max(end, ...values.map(value => value.proof.endMs)) })
  }
  return windows.sort((first, second) => first.start - second.start)
}

interface HistoryCache { key: string, at: number, windows: ComfortWindow[] }
interface Prepared { key: string, timezone: string, at: number, baseline: PersonalBaseline }

/** Historical work yields between bounded UTC-day reads, before acquiring any hardware side lock. */
export class ComfortSignalReader {
  private history: Partial<Record<Side, HistoryCache>> = {}
  private prepared: Partial<Record<Side, Prepared>> = {}
  constructor(private readonly database: Database.Database) {}

  private rows(side: Side, from: number, to: number, limit: number): unknown[] {
    // LEFT joins retain malformed/latest rows so they cannot silently fall back to old good data.
    const rows = this.database.prepare(`${query.replaceAll('JOIN ', 'LEFT JOIN ')}
      WHERE v.side=? AND v.timestamp>=? AND v.timestamp<? ORDER BY v.timestamp DESC, v.id DESC LIMIT ?`)
      .all(side, Math.floor(from / 1000), Math.ceil(to / 1000), limit + 1)
    if (rows.length > limit) throw new Error('Vital density exceeds the bounded reader')
    return rows
  }

  private spans(now: number): Map<string, Span> {
    const rows = this.database.prepare('SELECT id, epoch, start_ms AS startMs, end_ms AS endMs FROM biometric_mechanical_spans ORDER BY end_ms DESC LIMIT ?').all(MECHANICAL_MAX_SPANS + 1)
    if (rows.length > MECHANICAL_MAX_SPANS) throw new Error('Mechanical history exceeds retention bound')
    const spans = rows.map(row => mechanicalSpanSchema.parse(row)).filter(span => span.endMs <= now)
    return new Map(spans.map(span => [span.id, span]))
  }

  private latest(side: Side, now: number) {
    const raw = this.database.prepare(`${query.replaceAll('JOIN ', 'LEFT JOIN ')} WHERE v.side=? ORDER BY v.timestamp DESC, v.id DESC LIMIT 1`).get(side)
    const value = estimate(raw)
    if (value.timestampMs > now || now - value.timestampMs > 120_000 || value.proof.endMs > now) throw new Error('Latest estimate is not fresh')
    return value
  }

  async prepare(side: Side, timezone: string, now: number): Promise<void> {
    this.prepared[side] = undefined
    try {
      const latest = this.latest(side, now)
      let cache = this.history[side]
      if (!cache || cache.key !== latest.key || now < cache.at || now - cache.at >= 900_000) {
        const spans = this.spans(now), windows: ComfortWindow[] = []
        const from = now - 29 * HISTORY_DAY_MS, until = now - HISTORY_DAY_MS
        for (let start = Math.floor(from / HISTORY_DAY_MS) * HISTORY_DAY_MS; start < until; start += HISTORY_DAY_MS) {
          const rows = this.rows(side, Math.max(from, start), Math.min(until, start + HISTORY_DAY_MS), 1500)
          windows.push(...completeComfortWindows(rows, latest.key, spans, now))
          await yieldToControls()
        }
        cache = { key: latest.key, at: now, windows }
        this.history[side] = cache
      }
      // Re-check retained evidence every evaluation; deleted/invalidated spans cannot live on in a cached baseline.
      const spans = this.spans(now)
      const windows = cache.windows.filter((window) => {
        const span = spans.get(window.spanId)
        return span?.epoch === window.epoch && span.startMs <= window.evidenceStart && span.endMs >= window.evidenceEnd
      })
      this.prepared[side] = { key: latest.key, timezone, at: now, baseline: { ...personalBaseline(windows, timezone, now), asOf: cache.at } }
    }
    catch { this.history[side] = undefined }
  }

  read(side: Side, timezone: string, now: number): ComfortSignals {
    try {
      return this.database.transaction(() => {
        const latest = this.latest(side, now), snapshot = readMechanicalSnapshot(this.database, now)
        const state = snapshot?.state
        if (!snapshot || !state || state.reasons.length || state.confirmedThroughMs === null || now >= state.validUntilMs
          || state.confirmedThroughMs > now || latest.proof.spanId !== state.spanId || latest.proof.epoch !== state.epoch) throw new Error('Current quiet context unavailable')
        const confirmedThrough = state.confirmedThroughMs
        const spans = new Map(snapshot.spans.filter(span => span.id === state.spanId && span.epoch === state.epoch)
          .map(span => [span.id, { ...span, endMs: Math.min(span.endMs, confirmedThrough) }]))
        if (!covered(latest, spans, now)) throw new Error('Latest estimate is unqualified')
        const recent = completeComfortWindows(this.rows(side, now - 20 * 60_000, now + 1, 32), latest.key, spans, now).slice(-2)
        const prepared = this.prepared[side]
        const baseline = prepared?.key === latest.key && prepared.timezone === timezone && prepared.at <= now && now - prepared.at < 10_000 ? prepared.baseline : null
        const expiresAt = Math.min(state.validUntilMs, latest.timestampMs + 120_000, (recent.at(-1)?.end ?? now) + 360_000)
        return summarizeComfortSignals(baseline, recent, latest.input.sourceSide, expiresAt, now)
      })()
    }
    catch { return missingComfortSignals('Waiting for fresh, qualified Pod estimates and confirmed quiet hardware. Legacy and Apple Health readings are kept separate.') }
  }
}
