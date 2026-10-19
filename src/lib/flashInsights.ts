/** Pure counter analysis; no additional polling or persistent writes. */
export interface FlashSample { at: number, bootId: string, sectorsWritten: number }
export interface FlashWindow {
  hours: number
  coveredHours: number
  bytes: number
  bytesPerDay: number | null
}
const HOUR = 3_600_000

/**
 * Only continuous, same-boot intervals are usable. Skip resets, invalid
 * counters and gaps over two sampling periods. Boundary intervals are
 * prorated assuming a constant rate within the hourly sample.
 */
export function flashInsights(samples: FlashSample[], now: number) {
  const ordered = samples.filter(s => Number.isFinite(s.at) && s.at <= now
    && Number.isSafeInteger(s.sectorsWritten) && s.sectorsWritten >= 0 && s.bootId)
    .toSorted((a, b) => a.at - b.at)
  const intervals = ordered.slice(1).flatMap((cur, i) => {
    const prev = ordered[i]
    const duration = cur.at - prev.at
    if (cur.bootId !== prev.bootId || cur.sectorsWritten < prev.sectorsWritten
      || duration <= 0 || duration > 2 * HOUR) return []
    return [{ start: prev.at, end: cur.at, bytes: (cur.sectorsWritten - prev.sectorsWritten) * 512 }]
  })
  function window(hours: number, end = now): FlashWindow {
    let covered = 0
    let bytes = 0
    for (const interval of intervals) {
      const overlap = Math.max(0, Math.min(end, interval.end) - Math.max(end - hours * HOUR, interval.start))
      covered += overlap
      bytes += interval.bytes * overlap / (interval.end - interval.start)
    }
    return {
      hours,
      coveredHours: covered / HOUR,
      bytes: Math.round(bytes),
      bytesPerDay: covered >= HOUR ? Math.round(bytes * 24 * HOUR / covered) : null,
    }
  }
  return {
    windows: [1, 24, 168].map(hours => window(hours)),
    history: Array.from({ length: 24 }, (_, i) => {
      const end = now - (23 - i) * HOUR
      return { end, ...window(1, end) }
    }),
  }
}
