import { describe, expect, it } from 'vitest'
import { historyIntervals } from '../intervals'

describe('legacy presence interpretation', () => {
  it.each([null, '', '{}', '[[1]]', '[[10,5]]', '[[1,2.5]]', '[[1,"2"]]', '[null]'])('does not fabricate occupancy for %s', (value) => {
    const result = historyIntervals(value, 100, 1, 20)
    expect(result.intervals).toBeNull()
    expect(result.coveredSeconds).toBeNull()
  })
  it('treats empty and entirely out-of-window data as unknown rather than zero', () => {
    expect(historyIntervals('[]', 2, 100, 200).status).toBe('unavailable')
    expect(historyIntervals('[[1,10]]', 8, 100, 200).coveredSeconds).toBeNull()
  })
  it('merges, sorts and clips intervals without double-counting overlap', () => {
    expect(historyIntervals('[[15,40],[1,10],[5,20]]', 25, 2, 30)).toEqual({ status: 'available', intervals: [[2, 30]], coveredSeconds: 28 })
  })
  it('limits large arrays and oversized windows before interpreting them', () => {
    expect(historyIntervals(JSON.stringify(Array.from({ length: 10001 }, () => [1, 2])), 100000, 1, 3).status).toBe('invalid')
    expect(historyIntervals('[[1,2]]', 7, 1, 72 * 3600 + 2).status).toBe('unsupported_window')
  })
})
