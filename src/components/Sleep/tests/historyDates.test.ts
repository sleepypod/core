import { describe, expect, it } from 'vitest'
import { historyDayStart, historyRange, shiftHistoryDate, sourceDate } from '../historyDates'

describe('source-local history dates', () => {
  it.each([['2026-03-08', 23], ['2026-11-01', 25]])('preserves the whole Los Angeles DST day %s', (date, hours) => {
    const range = historyRange(date, date, 'America/Los_Angeles')
    if (!range) throw new Error('Expected a valid DST range')
    expect(Date.parse(range.endTime) - Date.parse(range.startTime)).toBe(hours * 3600000)
    expect(sourceDate(Date.parse(range.startTime) / 1000, 'America/Los_Angeles')).toBe(date)
    expect(sourceDate((Date.parse(range.endTime) - 1) / 1000, 'America/Los_Angeles')).toBe(date)
  })
  it('uses the original zone at midnight rather than the browser local date', () => {
    expect(new Date(historyDayStart('2026-10-10', 'Pacific/Kiritimati')).toISOString()).toBe('2026-10-09T10:00:00.000Z')
    expect(new Date(historyDayStart('2026-10-10', 'America/Los_Angeles')).toISOString()).toBe('2026-10-10T07:00:00.000Z')
    expect(shiftHistoryDate('2026-03-01', -1)).toBe('2026-02-28')
  })
  it('rejects malformed, normalized, skipped, reversed and oversized ranges', () => {
    for (const [from, through, zone] of [
      ['2026-02-28', '2026-02-30', 'UTC'], ['2026-02-30', '2026-03-01', 'UTC'],
      ['2011-12-30', '2011-12-30', 'Pacific/Apia'], ['2026-10-11', '2026-10-10', 'UTC'],
      ['2026-01-01', '2026-04-01', 'UTC'], ['', '', 'UTC'], ['2026-01-01', '2026-01-02', 'invalid'],
    ]) expect(historyRange(from, through, zone)).toBeNull()
  })
})
