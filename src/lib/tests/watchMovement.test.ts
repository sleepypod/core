import { expect, it } from 'vitest'
import { scaleWatchByNight, splitRuns, watchInWindows, watchPeak } from '../watchMovement'

const M = 60_000

it('takes the 95th percentile as the peak, never below 1', () => {
  expect(watchPeak([])).toBe(1)
  expect(watchPeak([0, 0, 0.5])).toBe(1)
  expect(watchPeak([...Array.from({ length: 99 }, (_, i) => i + 1), 1000])).toBe(96)
})

it('splits runs at gaps over two minutes', () => {
  const points = [0, M, 3 * M, 6 * M].map(t => ({ t }))
  expect(splitRuns(points).map(r => r.map(p => p.t / M))).toEqual([[0, 1, 3], [6]])
})

it('keeps minutes inside the windows only, sorted', () => {
  const minutes = [{ t: 5 * M, moving: 1 }, { t: M, moving: 2 }, { t: 50 * M, moving: 3 }]
  expect(watchInWindows(minutes, [{ start: 0, end: 10 * M }]).map(m => m.t)).toEqual([M, 5 * M])
})

it('scales each night to its own peak and clips at 1.2', () => {
  // One thrash in 40 minutes sits above the 95th percentile, so it clips instead of flattening the night.
  const night1 = Array.from({ length: 40 }, (_, i) => ({ t: i * M, moving: i === 39 ? 100 : 10 }))
  const night2 = Array.from({ length: 20 }, (_, i) => ({ t: 20 * 3600_000 + i * M, moving: 2 }))
  const scaled = scaleWatchByNight([...night1, ...night2])
  expect(scaled[0].scaled).toBe(1)
  expect(scaled[39].scaled).toBe(1.2)
  expect(scaled.slice(40).every(m => m.scaled === 1)).toBe(true)
})
