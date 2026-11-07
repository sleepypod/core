import { formatTick, type TimeFormat } from '@/src/lib/timeFormat'
export { formatClock, formatTick } from '@/src/lib/timeFormat'
import type { HypnoBlock, StageKey, WeekNight } from '@/src/components/ds'
import type { SleepStage, StageDistribution } from '@/src/lib/sleep-stages'
import type { inferRouterOutputs } from '@trpc/server'
import type { AppRouter } from '@/src/server/routers/app'

/* Pure data shaping for the Sleep screen (night grouping, formatting,
   hypnogram geometry, calendar math). Kept free of React so it is unit
   testable on its own. */

export type Side = 'left' | 'right'
export type SleepView = 'night' | 'week' | 'month'
export type NightAnalysis = inferRouterOutputs<AppRouter>['biometrics']['getSleepStages']

export interface SleepRecordRow {
  id: number
  enteredBedAt: Date
  leftBedAt: Date | null
  sleepDurationSeconds: number
  timesExitedBed: number
}

/** Sessions that start before this hour belong to the previous evening's night. */
export const NIGHT_ROLLOVER_HOUR = 12
const HOUR_MS = 3_600_000
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')

/** Local YYYY-MM-DD for a calendar day. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Keep morning fragments with the preceding evening, up to local noon. */
export function nightKey(enteredBedAt: Date): string {
  const d = new Date(enteredBedAt)
  if (d.getHours() < NIGHT_ROLLOVER_HOUR) d.setDate(d.getDate() - 1)
  return dayKey(d)
}

/** Local-noon Date for a YYYY-MM-DD key (safe for date formatting). */
export function keyToDate(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

/**
 * Query window for the nights that start on [from, to) calendar days:
 * shifted by the rollover so a 12:30 AM bedtime lands in the right night.
 */
export function nightWindow(from: Date, days: number): { startDate: Date, endDate: Date } {
  const start = new Date(from)
  start.setHours(NIGHT_ROLLOVER_HOUR, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + days)
  end.setMilliseconds(-1)
  return { startDate: start, endDate: end }
}

export function groupByNight<T extends SleepRecordRow>(records: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const r of records) {
    const k = nightKey(new Date(r.enteredBedAt))
    const list = map.get(k)
    if (list) list.push(r)
    else map.set(k, [r])
  }
  return map
}

/** A representative record for editing one session; never a whole-night total. */
export function mainRecord<T extends SleepRecordRow>(records: T[] | undefined): T | undefined {
  if (!records?.length) return undefined
  return records.reduce((a, b) => (b.sleepDurationSeconds > a.sleepDurationSeconds ? b : a))
}

/** Merge recorded windows without inventing sleep in gaps or counting overlaps twice. */
export function recordingSummary(records: SleepRecordRow[]) {
  const windows = records.map((record) => {
    const start = new Date(record.enteredBedAt).getTime()
    const end = record.leftBedAt ? new Date(record.leftBedAt).getTime() : start + Math.max(0, record.sleepDurationSeconds) * 1000
    return { start, end }
  }).filter(window => Number.isFinite(window.start) && Number.isFinite(window.end) && window.start > 0 && window.end > window.start)
    .sort((first, second) => first.start - second.start)
  const intervals: Array<{ start: number, end: number }> = []
  for (const window of windows) {
    const previous = intervals.at(-1)
    if (previous && window.start <= previous.end) previous.end = Math.max(previous.end, window.end)
    else intervals.push({ ...window })
  }
  const start = intervals[0]?.start ?? null
  const end = intervals.at(-1)?.end ?? null
  const seconds = intervals.reduce((total, interval) => total + (interval.end - interval.start) / 1000, 0)
  return { start, end, seconds, gaps: start != null && end != null ? Math.max(0, (end - start) / 1000 - seconds) : 0, count: new Set(records.map(record => record.id)).size }
}

/* ─── Formatting ─────────────────────────────────────────────────────── */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds / 60)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m}m`
  return `${h}h ${m}m`
}

export function formatNightLong(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
}

export function formatNightShort(d: Date): string {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function formatRange(start: Date, end: Date): string {
  const sameMonth = start.getMonth() === end.getMonth()
  const a = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const b = sameMonth ? String(end.getDate()) : end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `${a} – ${b}`
}

/* ─── Hypnogram ──────────────────────────────────────────────────────── */

const STAGE_KEY: Record<SleepStage, StageKey> = { wake: 'awake', rem: 'rem', light: 'light', deep: 'deep' }

export function toHypnoBlocks(
  blocks: Array<{ start: number, end: number, stage: SleepStage }>,
  start: number,
  end: number,
): HypnoBlock[] {
  const span = end - start
  if (!(span > 0)) return []
  return blocks
    .map((b) => {
      const s = Math.max(start, b.start)
      const e = Math.min(end, b.end)
      return {
        stage: STAGE_KEY[b.stage],
        startPct: ((s - start) / span) * 100,
        widthPct: ((e - s) / span) * 100,
      }
    })
    .filter(b => b.widthPct > 0)
}

export interface Tick {
  label: string
  pct: number
}

/** Start + end labels, plus whole hours every `step` h that aren't crowding the ends. */
export function hypnoTicks(start: number, end: number, step = 2, timeFormat: TimeFormat = '12h'): Tick[] {
  const span = end - start
  if (!(span > 0)) return []
  const ticks: Tick[] = [{ label: formatTick(start, timeFormat), pct: 0 }]
  const first = new Date(start)
  first.setMinutes(0, 0, 0)
  first.setTime(first.getTime() + HOUR_MS)
  // Align to odd hours (1, 3, 5 AM) when stepping by two, matching the spec.
  if (step === 2 && first.getHours() % 2 === 0) first.setTime(first.getTime() + HOUR_MS)
  for (let t = first.getTime(); t < end; t += step * HOUR_MS) {
    const pct = ((t - start) / span) * 100
    if (pct >= 16 && pct <= 84) ticks.push({ label: formatTick(t, timeFormat), pct })
  }
  ticks.push({ label: formatTick(end, timeFormat), pct: 100 })
  return ticks
}

/** Milliseconds per stage from classified epochs. */
export function stageDurations(epochs: Array<{ stage: SleepStage, duration: number }>): Record<StageKey, number> {
  const out: Record<StageKey, number> = { awake: 0, rem: 0, light: 0, deep: 0 }
  for (const e of epochs) out[STAGE_KEY[e.stage]] += e.duration
  return out
}

/** Average consecutive runs so a long night plots as at most `max` points; nulls are skipped. */
export function downsample(values: Array<number | null | undefined>, max = 96): number[] {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x))
  if (v.length <= max) return v
  const size = v.length / max
  return Array.from({ length: max }, (_, i) => {
    const chunk = v.slice(Math.floor(i * size), Math.floor((i + 1) * size))
    return chunk.reduce((s, x) => s + x, 0) / chunk.length
  })
}

export function average(values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => x != null && Number.isFinite(x))
  if (v.length === 0) return null
  return v.reduce((s, x) => s + x, 0) / v.length
}

/* ─── Nights (week) ──────────────────────────────────────────────────── */

export interface NightSummary {
  key: string
  date: Date
  record?: SleepRecordRow
  /** Recorded bed hours across all sessions; not proof of sleep. */
  hours: number
  exits: number
  bedtime: Date | null
  wake: Date | null
  distribution: StageDistribution | null
  quality: number | null
  hr: number | null
  hrv: number | null
  br: number | null
  analysis?: NightAnalysis
  analysisLoading?: boolean
  analysisError?: boolean
  asleepSeconds?: number | null
}

/** Use the same persisted/model-aware whole-night result as Night; never reclassify it here. */
export function withNightAnalysis(night: NightSummary, analysis?: NightAnalysis): NightSummary {
  if (!analysis || (analysis.recording && analysis.recording.nightDate !== night.key)) return night
  const epochs = analysis.epochs
  const recording = analysis.recording
  const durations = stageDurations(epochs)
  return {
    ...night,
    analysis,
    hours: recording ? recording.durationMs / HOUR_MS : night.hours,
    bedtime: recording ? new Date(recording.start) : night.bedtime,
    wake: recording ? new Date(recording.end) : night.wake,
    exits: recording?.exits ?? night.exits,
    distribution: epochs.length ? analysis.distribution : null,
    quality: epochs.length ? analysis.qualityScore : null,
    asleepSeconds: epochs.length ? (durations.light + durations.deep + durations.rem) / 1000 : null,
    hr: average(epochs.map(epoch => epoch.heartRate)),
    hrv: average(epochs.map(epoch => epoch.hrv)),
    br: average(epochs.map(epoch => epoch.breathingRate)),
  }
}

/** Recorded coverage only. Analysis is supplied by the authoritative whole-night API. */
export function buildNights(from: Date, days: number, records: SleepRecordRow[]): NightSummary[] {
  const byNight = groupByNight(records)
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(from)
    date.setDate(date.getDate() + index)
    const key = dayKey(date)
    const sessions = byNight.get(key) ?? []
    const recording = recordingSummary(sessions)
    return {
      key, date: keyToDate(key), record: mainRecord(sessions),
      hours: recording.seconds / 3600,
      exits: sessions.reduce((total, session) => total + session.timesExitedBed, 0),
      bedtime: recording.start == null ? null : new Date(recording.start),
      wake: recording.end == null ? null : new Date(recording.end),
      distribution: null, quality: null, hr: null, hrv: null, br: null, asleepSeconds: null,
    }
  })
}

export function toWeekNights(nights: NightSummary[], detailed: boolean): WeekNight[] {
  return nights.map(n => ({
    label: detailed ? `${DAY_NAMES[n.date.getDay()]} ${n.date.getDate()}` : DAY_NAMES[n.date.getDay()][0],
    hours: n.hours,
    quality: n.quality,
    // Bar height is recorded bed time, which includes awake and unstaged intervals.
    // Stage proportions belong in the full-night detail, not rescaled onto bed time.
    split: null,
  }))
}

/**
 * Average clock time for times around midnight (bedtimes/wakes): minutes
 * are measured from noon so 11 PM and 1 AM average to midnight, not noon.
 */
export function averageClock(dates: Array<Date | null>): Date | null {
  const valid = dates.filter((d): d is Date => d != null)
  if (valid.length === 0) return null
  const fromNoon = valid.map((d) => {
    const m = d.getHours() * 60 + d.getMinutes()
    return (m - 720 + 1440) % 1440
  })
  const avg = Math.round(fromNoon.reduce((s, x) => s + x, 0) / fromNoon.length)
  const minutes = (avg + 720) % 1440
  const out = new Date(valid[0])
  out.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  return out
}

/* ─── Month ──────────────────────────────────────────────────────────── */

export function monthStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function daysInMonth(month: Date): number {
  return new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
}

/** Leading blanks (Sunday-first) followed by each day of the month. */
export function monthCells(month: Date): Array<Date | null> {
  const first = monthStart(month)
  const cells: Array<Date | null> = Array.from({ length: first.getDay() }, () => null)
  for (let d = 1; d <= daysInMonth(first); d++) cells.push(new Date(first.getFullYear(), first.getMonth(), d, 12))
  return cells
}

/** Heat opacity: 5h → 0.1, 8h → 0.6, clamped. */
export function heatAlpha(hours: number): number {
  const t = Math.max(0, Math.min(1, (hours - 5) / 3))
  return Math.round((0.1 + t * 0.5) * 100) / 100
}

/** Sunday-first weeks overlapping the month, stopping at `today`. */
export function monthWeeks(month: Date, today: Date = new Date()): Array<{ start: Date, end: Date }> {
  const first = monthStart(month)
  const last = new Date(first.getFullYear(), first.getMonth(), daysInMonth(first), 12)
  const start = new Date(first)
  start.setDate(start.getDate() - start.getDay())
  const weeks: Array<{ start: Date, end: Date }> = []
  for (let s = start; s <= last && s <= today; s = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 7)) {
    weeks.push({ start: new Date(s), end: new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6) })
  }
  return weeks
}
