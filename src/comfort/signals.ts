import { z } from 'zod'

export const COMFORT_WINDOW_MS = 300_000
export const BASELINE_DAYS_REQUIRED = 7
export const BASELINE_WINDOWS_PER_DAY = 12
export const HISTORY_DAY_MS = 86_400_000

const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
export const comfortSignalsSchema = z.object({
  state: z.enum(['learning', 'ready', 'stale', 'review']), reason: z.string(),
  sampleAt: time.nullable(), expiresAt: time.nullable(),
  baselineHeartRate: z.number().finite().nullable(), baselineDays: z.number().int().nonnegative(),
  baselineWindows: z.number().int().nonnegative(), baselineAsOf: time.nullable(),
  recentHeartRates: z.array(z.number().finite()).max(2),
  sourceSide: z.enum(['left', 'right']).nullable(),
  source: z.literal('qualified_live_pod'),
})
export type ComfortSignals = z.infer<typeof comfortSignalsSchema>
export interface ComfortWindow { start: number, end: number, heartRate: number, spanId: string, epoch: string, evidenceStart: number, evidenceEnd: number }
export interface PersonalBaseline { heartRate: number | null, days: number, windows: number, asOf: number }

export function missingComfortSignals(reason = 'Waiting for qualified live Pod estimates.'): ComfortSignals {
  return { state: 'stale', reason, sampleAt: null, expiresAt: null, baselineHeartRate: null,
    baselineDays: 0, baselineWindows: 0, baselineAsOf: null, recentHeartRates: [], sourceSide: null, source: 'qualified_live_pod' }
}

export function median(values: number[]): number {
  const sorted = [...values].sort((first, second) => first - second)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/** Each qualified local date has equal weight, regardless of recording length. */
export function personalBaseline(windows: ComfortWindow[], timezone: string, now: number): PersonalBaseline {
  const dates = new Map<string, Map<number, number>>()
  const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' })
  for (const window of windows) {
    if (window.start < now - 29 * HISTORY_DAY_MS || window.end > now - HISTORY_DAY_MS) continue
    const date = dateFormatter.format(window.end - 1)
    const values = dates.get(date) ?? new Map<number, number>()
    values.set(window.start, window.heartRate)
    dates.set(date, values)
  }
  const days = [...dates.values()].filter(values => values.size >= BASELINE_WINDOWS_PER_DAY)
  return { heartRate: days.length >= BASELINE_DAYS_REQUIRED ? median(days.map(values => median([...values.values()]))) : null,
    days: days.length, windows: days.reduce((count, values) => count + values.size, 0), asOf: now }
}

/** A deviation is a reason to hold comfort proposals, never a diagnosis or treatment. */
export function summarizeComfortSignals(baseline: PersonalBaseline | null, recent: ComfortWindow[], sourceSide: 'left' | 'right', expiresAt: number, now: number): ComfortSignals {
  const latest = recent.at(-1)
  const output: ComfortSignals = { ...missingComfortSignals(), sourceSide,
    baselineHeartRate: baseline?.heartRate ?? null, baselineDays: baseline?.days ?? 0,
    baselineWindows: baseline?.windows ?? 0, baselineAsOf: baseline?.asOf ?? null,
    sampleAt: latest?.end ?? null, expiresAt, recentHeartRates: recent.map(window => window.heartRate) }
  if (recent.length !== 2 || !latest || recent[0].end !== latest.start || latest.end > now
    || now - latest.end > 360_000 || now >= expiresAt) {
    return { ...output, state: 'stale', reason: 'Waiting for two adjacent, complete five-minute summaries with fresh quiet-state evidence.' }
  }
  if (!baseline || baseline.heartRate === null) return { ...output, state: 'learning',
    reason: `Learning your Pod baseline: ${output.baselineDays} of ${BASELINE_DAYS_REQUIRED} qualified days. Each day needs at least ${BASELINE_WINDOWS_PER_DAY} complete summaries.` }
  const baselineHeartRate = baseline.heartRate
  const threshold = Math.max(10, baselineHeartRate * 0.2)
  const deviations = recent.map(window => window.heartRate - baselineHeartRate)
  if (deviations.every(value => value >= threshold) || deviations.every(value => value <= -threshold)) {
    return { ...output, state: 'review', reason: 'Both recent summaries differ from your baseline. Holding comfort proposals; this estimate does not identify a medical condition.' }
  }
  return { ...output, state: 'ready', reason: 'Recent qualified Pod estimates are within the personal comparison guard. Other comfort safeguards still apply.' }
}
