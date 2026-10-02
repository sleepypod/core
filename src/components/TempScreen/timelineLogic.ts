import { buildTimeline } from '@/src/components/Schedule/CurveChart'
import { nightSetPoints, type TempRow } from '@/src/components/Schedule/bothNight'
import { tonightWindow } from '@/src/components/diagnostics/dashboardLogic'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const HALF_DAY_MIN = 12 * 60
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
export interface CurvePoint { at: number, temperature: number }

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

/**
 * A night's set points on absolute time. A curve saved entirely before noon
 * belongs to the morning after `midnight` (same rule as the Scheduler lanes).
 */
export function nightCurve(temps: TempRow[] | undefined, midnight: Date): CurvePoint[] {
  const tl = buildTimeline(nightSetPoints(temps, DAYS_OF_WEEK[midnight.getDay()]))
  const shift = tl.length > 0 && tl[tl.length - 1].minutes < HALF_DAY_MIN ? 24 * 60 : 0
  return tl.map(p => ({
    at: new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, p.minutes + shift).getTime(),
    temperature: p.temperature,
  }))
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
    if (c.length === 0 || t < c[0].at || t > c[c.length - 1].at) continue
    let held = c[0].temperature
    for (const p of c) if (p.at <= t) held = p.temperature
    return held
  }
  return null
}

/** The first set point after `now` across the given curves. */
export function nextPoint(curves: CurvePoint[][], now: number): CurvePoint | null {
  let best: CurvePoint | null = null
  for (const c of curves) for (const p of c) if (p.at > now && (!best || p.at < best.at)) best = p
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

