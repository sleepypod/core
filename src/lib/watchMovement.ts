/**
 * Chart helpers for Apple Watch wrist movement (moving readings per minute)
 * drawn over the pod's movement. Watch motion is a comparison label only.
 *
 * Rules learned from the iOS chart: a missing minute is no data, never
 * stillness, so lines never bridge gaps; only minutes inside the sleep session
 * shown are drawn and scaled; each night is scaled to its own peak.
 */

export interface WatchMinute { t: number, moving: number }

/** The longest window biometrics.getWatchMotionSeries serves (31 days). */
export const WATCH_MOTION_MAX_SERIES_MS = 31 * 24 * 60 * 60_000
/** Consecutive minutes further apart than this are not joined. */
export const WATCH_GAP_MS = 2 * 60_000
/** Watch minutes further apart than this belong to different nights for scaling. */
export const WATCH_NIGHT_GAP_MS = 4 * 60 * 60_000
/** A normalized value may overshoot the night's peak by this much before it is clipped. */
export const WATCH_MAX_SCALE = 1.2

/** The 95th percentile (at least 1), so one thrash does not flatten the rest of the night. Matches iOS. */
export function watchPeak(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 0) return 1
  return Math.max(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], 1)
}

/** Minutes inside any of the windows, time-sorted. */
export function watchInWindows(minutes: WatchMinute[], windows: Array<{ start: number, end: number }>): WatchMinute[] {
  return minutes.filter(m => windows.some(w => m.t >= w.start && m.t <= w.end)).sort((a, b) => a.t - b.t)
}

/**
 * Each minute's movement as a fraction of its night's peak, clipped at
 * WATCH_MAX_SCALE. Pass only minutes already restricted to the sessions shown.
 */
export function scaleWatchByNight(minutes: WatchMinute[], nightGapMs = WATCH_NIGHT_GAP_MS): Array<WatchMinute & { scaled: number }> {
  const out: Array<WatchMinute & { scaled: number }> = []
  for (const night of splitRuns(minutes, nightGapMs)) {
    const peak = watchPeak(night.map(m => m.moving))
    for (const m of night) out.push({ ...m, scaled: Math.min(m.moving / peak, WATCH_MAX_SCALE) })
  }
  return out
}

/**
 * Watch movement summed into chart buckets (aligned like the pod's
 * getMovementBuckets) for each night window, each night scaled to the 95th
 * percentile of its own buckets. Minutes outside every night are ignored.
 */
export function watchBuckets(minutes: WatchMinute[], nights: Array<{ start: number, end: number }>, bucketMs: number): Map<number, { moving: number, scaled: number }> {
  const out = new Map<number, { moving: number, scaled: number }>()
  const used = new Set<number>()
  for (const night of nights) {
    const sums = new Map<number, number>()
    for (const m of minutes) {
      if (m.t < night.start || m.t > night.end || used.has(m.t)) continue
      used.add(m.t)
      const key = Math.floor(m.t / bucketMs) * bucketMs
      sums.set(key, (sums.get(key) ?? 0) + m.moving)
    }
    const peak = watchPeak([...sums.values()])
    for (const [key, moving] of sums) {
      const prior = out.get(key)?.moving ?? 0
      out.set(key, { moving: prior + moving, scaled: Math.min((prior + moving) / peak, WATCH_MAX_SCALE) })
    }
  }
  return out
}

/** Time-sorted points split wherever the next is more than `gapMs` later. */
export function splitRuns<T extends { t: number }>(points: T[], gapMs = WATCH_GAP_MS): T[][] {
  const runs: T[][] = []
  for (const p of points) {
    const run = runs[runs.length - 1]
    if (run && p.t - run[run.length - 1].t <= gapMs) run.push(p)
    else runs.push([p])
  }
  return runs
}
