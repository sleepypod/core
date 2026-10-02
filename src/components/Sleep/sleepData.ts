import type { HypnoBlock, StageKey, WeekNight } from '@/src/components/ds'
import {
  calculateDistribution,
  calculateQualityScore,
  classifySleepStages,
  type SleepStage,
  type StageDistribution,
} from '@/src/lib/sleep-stages'

/* Pure data shaping for the Sleep screen (night grouping, formatting,
   hypnogram geometry, calendar math). Kept free of React so it is unit
   testable on its own. */

export type Side = 'left' | 'right'
export type SleepView = 'night' | 'week' | 'month'

export interface SleepRecordRow {
  id: number
  enteredBedAt: Date
  leftBedAt: Date | null
  sleepDurationSeconds: number
  timesExitedBed: number
}

export interface VitalsRow {
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

export interface MovementRow {
  timestamp: Date
  totalMovement: number
}

/** Sessions that start before this hour belong to the previous evening's night. */
export const NIGHT_ROLLOVER_HOUR = 6
const HOUR_MS = 3_600_000
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad = (n: number) => String(n).padStart(2, '0')

/** Local YYYY-MM-DD for a calendar day. */
export function dayKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The night a session belongs to: its local start day, minus one before 6 AM. */
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

/** The session that represents a night: the longest one (naps lose). */
export function mainRecord<T extends SleepRecordRow>(records: T[] | undefined): T | undefined {
  if (!records?.length) return undefined
  return records.reduce((a, b) => (b.sleepDurationSeconds > a.sleepDurationSeconds ? b : a))
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

export function formatClock(d: Date | number | null | undefined): string {
  if (d == null) return '—'
  return new Date(d).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

/** "11 PM" on the hour, "11:20 PM" otherwise — axis ticks. */
export function formatTick(ms: number): string {
  const d = new Date(ms)
  return d.getMinutes() === 0
    ? d.toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })
    : formatClock(d)
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
export function hypnoTicks(start: number, end: number, step = 2): Tick[] {
  const span = end - start
  if (!(span > 0)) return []
  const ticks: Tick[] = [{ label: formatTick(start), pct: 0 }]
  const first = new Date(start)
  first.setMinutes(0, 0, 0)
  first.setTime(first.getTime() + HOUR_MS)
  // Align to odd hours (1, 3, 5 AM) when stepping by two, matching the spec.
  if (step === 2 && first.getHours() % 2 === 0) first.setTime(first.getTime() + HOUR_MS)
  for (let t = first.getTime(); t < end; t += step * HOUR_MS) {
    const pct = ((t - start) / span) * 100
    if (pct >= 16 && pct <= 84) ticks.push({ label: formatTick(t), pct })
  }
  ticks.push({ label: formatTick(end), pct: 100 })
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
  /** Hours asleep across all sessions of the night. */
  hours: number
  exits: number
  bedtime: Date | null
  wake: Date | null
  distribution: StageDistribution | null
  quality: number | null
  hr: number | null
  hrv: number | null
  br: number | null
}

/**
 * Build `days` consecutive nights starting at `from`, classifying each
 * night's stages client-side from the range's vitals + movement.
 */
export function buildNights(
  from: Date,
  days: number,
  records: SleepRecordRow[],
  vitals: VitalsRow[] = [],
  movement: MovementRow[] = [],
): NightSummary[] {
  const byNight = groupByNight(records)
  const sortedVitals = [...vitals].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  const out: NightSummary[] = []
  for (let i = 0; i < days; i++) {
    const day = new Date(from)
    day.setDate(day.getDate() + i)
    const key = dayKey(day)
    const recs = byNight.get(key) ?? []
    const main = mainRecord(recs)
    let distribution: StageDistribution | null = null
    let quality: number | null = null
    let hr: number | null = null
    let hrv: number | null = null
    let br: number | null = null
    if (main) {
      const s = new Date(main.enteredBedAt).getTime()
      const e = main.leftBedAt ? new Date(main.leftBedAt).getTime() : s + main.sleepDurationSeconds * 1000
      const inWindow = (t: Date) => {
        const ms = new Date(t).getTime()
        return ms >= s && ms <= e
      }
      const nv = sortedVitals.filter(v => inWindow(v.timestamp)).map(v => ({ ...v, timestamp: new Date(v.timestamp) }))
      if (nv.length > 0) {
        const nm = movement.filter(m => inWindow(m.timestamp)).map(m => ({ ...m, timestamp: new Date(m.timestamp) }))
        const epochs = classifySleepStages(nv, nm)
        if (epochs.length > 0) {
          distribution = calculateDistribution(epochs)
          quality = calculateQualityScore(distribution)
        }
        hr = average(nv.map(v => v.heartRate))
        hrv = average(nv.map(v => v.hrv))
        br = average(nv.map(v => v.breathingRate))
      }
    }
    out.push({
      key,
      date: keyToDate(key),
      record: main,
      hours: recs.reduce((sum, r) => sum + r.sleepDurationSeconds, 0) / 3600,
      exits: recs.reduce((sum, r) => sum + r.timesExitedBed, 0),
      bedtime: main ? new Date(main.enteredBedAt) : null,
      wake: main?.leftBedAt ? new Date(main.leftBedAt) : null,
      distribution,
      quality,
      hr,
      hrv,
      br,
    })
  }
  return out
}

/** REM/Light/Deep split (percent of non-wake time) for WeekBars. */
export function sleepSplit(d: StageDistribution | null): WeekNight['split'] {
  if (!d) return undefined
  const asleep = d.rem + d.light + d.deep
  if (asleep <= 0) return undefined
  return { rem: (d.rem / asleep) * 100, light: (d.light / asleep) * 100, deep: (d.deep / asleep) * 100 }
}

export function toWeekNights(nights: NightSummary[], detailed: boolean): WeekNight[] {
  return nights.map(n => ({
    label: detailed ? `${DAY_NAMES[n.date.getDay()]} ${n.date.getDate()}` : DAY_NAMES[n.date.getDay()][0],
    hours: n.hours,
    quality: n.quality,
    split: sleepSplit(n.distribution),
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
