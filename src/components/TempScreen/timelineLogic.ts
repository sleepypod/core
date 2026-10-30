import { buildTimeline } from '@/src/components/Schedule/CurveChart'
import { nightSetPoints, type TempRow } from '@/src/components/Schedule/bothNight'
import { tonightWindow } from '@/src/components/diagnostics/dashboardLogic'
import { DAYS_OF_WEEK, hhmmToMinutes } from '@/src/lib/scheduleTime'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** Gaps shorter than this between a schedule edge and presence aren't worth a label. */
const MISMATCH_MIN_MS = 15 * MINUTE

export interface Night {
  key: 'last' | 'tonight'
  /** Local midnight of the day the night's curve is saved under. */
  midnight: Date
}

export interface TimelineWindow {
  start: number
  end: number
  nights: [Night, Night]
}

export interface Interval { start: number, end: number }
export interface CurvePoint { at: number, temperature: number, boundary?: true }
export interface PowerCurveRow {
  dayOfWeek: string
  onTime: string
  offTime: string
  offDayOffset?: number
  endAction?: string
  onTemperature: number
  enabled: boolean
}

/**
 * 6 PM the evening before last night → 9 AM after tonight. "Tonight" flips at
 * 9 AM like the System Dashboard, so the now line always sits in the window.
 */
export function timelineWindow(now: Date): TimelineWindow {
  const tonight = tonightWindow(now).midnight
  const last = new Date(tonight.getFullYear(), tonight.getMonth(), tonight.getDate() - 1)
  const at = (d: Date, h: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), h).getTime()
  return {
    start: at(last, 18),
    end: at(tonight, 33),
    nights: [{ key: 'last', midnight: last }, { key: 'tonight', midnight: tonight }],
  }
}

/** Project actual calendar rows onto one displayed night without changing their weekdays. */
export function nightCurve(temps: TempRow[] | undefined, midnight: Date, powers?: PowerCurveRow[]): CurvePoint[] {
  const tl = buildTimeline(nightSetPoints(temps, DAYS_OF_WEEK[midnight.getDay()]))
  const points = tl.flatMap((point) => {
    const at = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, point.minutes)
    // Match cron's midnight-gap exception; ordinary spring gaps shift forward.
    if (Math.floor(point.minutes / 60) % 24 === 0 && at.getHours() !== 0) return []
    return [{ at: at.getTime(), temperature: point.temperature }]
  })
  // A bounded power routine supplies the initial target even with no later phases.
  // Keep legacy calendar-only curves intact when no unambiguous window exists.
  const starts = (powers ?? []).filter(row => row.enabled).flatMap((row) => {
    const morning = hhmmToMinutes(row.onTime) < 12 * 60
    const dayOffset = Number(morning)
    const day = DAYS_OF_WEEK[(midnight.getDay() + dayOffset) % 7]
    if (row.dayOfWeek !== day) return []
    return [{ row, dayOffset }]
  })
  if (starts.length !== 1) return points
  const { row, dayOffset } = starts[0]
  if (row.endAction === 'maintain') return points
  const localTime = (time: string, offset: number): number | null => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
    const minutes = hhmmToMinutes(time)
    const instant = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + offset, 0, minutes)
    return minutes < 60 && instant.getHours() !== 0 ? null : instant.getTime()
  }
  const start = localTime(row.onTime, dayOffset)
  const end = localTime(row.offTime, dayOffset + (row.offDayOffset ?? 0))
  // Never turn a legacy calendar OFF into a guessed next-morning OFF.
  if (start === null || end === null || end <= start || end - start > 26 * HOUR
    || !Number.isFinite(row.onTemperature)) return points
  const phases = points.filter(point => point.at > start && point.at < end)
  return [
    { at: start, temperature: row.onTemperature },
    ...phases,
    { at: end, temperature: phases.at(-1)?.temperature ?? row.onTemperature, boundary: true },
  ]
}

export interface SleepRecordLike {
  enteredBedAt: Date
  leftBedAt: Date | null
  presentIntervals: unknown
}

/** Stored interval edges are epoch seconds; tolerate milliseconds too. */
const toMs = (v: number) => (v < 1e12 ? v * 1000 : v)

/**
 * In-bed intervals clipped to [from, to]. Uses the record's present intervals
 * (so exits show as gaps) and falls back to enteredBedAt → leftBedAt; an open
 * session runs to `now`.
 */
export function presenceIntervals(records: SleepRecordLike[] | undefined, from: number, to: number, now: number): Interval[] {
  const out: Interval[] = []
  for (const r of records ?? []) {
    const raw = Array.isArray(r.presentIntervals) ? r.presentIntervals : []
    const pairs = raw.filter((p): p is [number, number | null] => Array.isArray(p) && typeof p[0] === 'number')
    const spans = pairs.length > 0
      ? pairs.map(([s, e]) => ({ start: toMs(s), end: typeof e === 'number' ? toMs(e) : (r.leftBedAt?.getTime() ?? now) }))
      : [{ start: r.enteredBedAt.getTime(), end: r.leftBedAt?.getTime() ?? now }]
    for (const s of spans) {
      const start = Math.max(s.start, from)
      const end = Math.min(s.end, to)
      if (end > start) out.push({ start, end })
    }
  }
  return out.sort((a, b) => a.start - b.start)
}

/**
 * Powered stretches from thermal history buckets: a bucket with a target was
 * powered. Neighbouring buckets (gap ≤ 2 buckets) merge into one stretch.
 */
export function powerIntervals(points: Array<{ t: number } & Record<string, number | null>> | undefined, key: string, bucketMs: number): Interval[] {
  const out: Interval[] = []
  for (const p of points ?? []) {
    if (p[key] == null) continue
    const start = p.t - bucketMs / 2
    const end = p.t + bucketMs / 2
    const last = out[out.length - 1]
    if (last && start - last.end <= 2 * bucketMs) last.end = end
    else out.push({ start, end })
  }
  return out
}

export interface NightMismatch {
  /** Schedule running with nobody in bed, from its start until the first entry. */
  emptyBefore: Interval | null
  /** Still in bed after the schedule ended. */
  pastEnd: Interval | null
}

/**
 * Compare a night's schedule with when someone was actually in bed. Presence
 * counts toward the night when it overlaps the schedule (or starts within 6 h
 * of its end, for a lie-in).
 */
export function nightMismatch(curve: CurvePoint[], presence: Interval[]): NightMismatch {
  if (curve.length < 2) return { emptyBefore: null, pastEnd: null }
  const start = curve[0].at
  const end = curve[curve.length - 1].at
  const night = presence.filter(p => p.end > start && p.start < end + 6 * HOUR)
  if (night.length === 0) return { emptyBefore: null, pastEnd: null }
  const firstIn = night[0].start
  const lastOut = Math.max(...night.map(p => p.end))
  return {
    emptyBefore: firstIn - start >= MISMATCH_MIN_MS ? { start, end: firstIn } : null,
    pastEnd: lastOut - end >= MISMATCH_MIN_MS ? { start: end, end: lastOut } : null,
  }
}

/** The set point held at `t` by whichever curve covers it, or null when none does. */
export function targetAt(curves: CurvePoint[][], t: number): number | null {
  for (const c of curves) {
    if (c.length === 0 || t < c[0].at || t > c[c.length - 1].at || (t === c[c.length - 1].at && c[c.length - 1].boundary)) continue
    let held = c[0].temperature
    for (const p of c) if (p.at <= t) held = p.temperature
    return held
  }
  return null
}

/** The first set point after `now` across the given curves. */
export function nextPoint(curves: CurvePoint[][], now: number): CurvePoint | null {
  let best: CurvePoint | null = null
  for (const c of curves) for (const p of c) if (!p.boundary && p.at > now && (!best || p.at < best.at)) best = p
  return best
}

/** Shared temperature range for a side's lanes, at least 6° tall. */
export function tempRange(curves: CurvePoint[][]): { lo: number, hi: number } | null {
  const temps = curves.flat().map(p => p.temperature)
  if (temps.length === 0) return null
  let lo = Math.min(...temps) - 1
  let hi = Math.max(...temps) + 1
  if (hi - lo < 6) {
    const mid = (lo + hi) / 2
    lo = mid - 3
    hi = mid + 3
  }
  return { lo, hi }
}

