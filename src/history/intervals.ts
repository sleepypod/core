import { HISTORY_MAX_INTERVAL_BYTES, type HistoryIntervals } from './contract'

/** Normalize overlapping source intervals without treating missing presence as zero. */
export function historyIntervals(raw: unknown, byteLength: number, start: number, end: number): HistoryIntervals {
  const missing = (status: HistoryIntervals['status']): HistoryIntervals => ({ status, intervals: null, coveredSeconds: null })
  if (end - start > 72 * 3600) return missing('unsupported_window')
  if (byteLength > HISTORY_MAX_INTERVAL_BYTES) return missing('too_large')
  if (typeof raw !== 'string') return missing('unavailable')
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  }
  catch { return missing('invalid') }
  if (!Array.isArray(decoded) || decoded.length > 10000) return missing('invalid')
  if (!decoded.length) return missing('unavailable')
  const clipped: Array<[number, number]> = []
  for (const value of decoded) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isSafeInteger) || value[1] <= value[0]) return missing('invalid')
    const first = Math.max(start, value[0])
    const last = Math.min(end, value[1])
    if (last > first) clipped.push([first, last])
  }
  clipped.sort((first, second) => first[0] - second[0])
  if (!clipped.length) return missing('unavailable')
  const intervals: Array<[number, number]> = []
  for (const interval of clipped) {
    const previous = intervals.at(-1)
    if (previous && interval[0] <= previous[1]) previous[1] = Math.max(previous[1], interval[1])
    else intervals.push([...interval])
  }
  return { status: 'available', intervals, coveredSeconds: intervals.reduce((total, [first, last]) => total + last - first, 0) }
}
