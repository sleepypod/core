import { describe, expect, it } from 'vitest'
import { recordingWindows, selectNightRecords, sleepNightKey, summarizeRecording } from '../sleep-recording'

const record = (id: number, start: string, end: string) => ({ id, enteredBedAt: new Date(start), leftBedAt: new Date(end), timesExitedBed: 1 })

describe('complete-night recording evidence', () => {
  it('keeps a newer fragmented night ahead of an older long session', () => {
    const older = record(1, '2026-06-03T22:00:00Z', '2026-06-04T06:00:00Z')
    const first = record(2, '2026-06-04T23:00:00Z', '2026-06-05T01:00:00Z')
    const second = record(3, '2026-06-05T02:00:00Z', '2026-06-05T04:00:00Z')
    const third = record(4, '2026-06-05T04:30:00Z', '2026-06-05T07:00:00Z')
    const selected = selectNightRecords([second, older, third, first], 'UTC')
    expect(selected.map(value => value.id)).toEqual([2, 3, 4])
    expect(summarizeRecording(selected, 'UTC')).toMatchObject({ durationMs: 6.5 * 3600000, gapsMs: 1.5 * 3600000, recordIds: [2, 3, 4], exits: 3 })
  })

  it('unions overlaps once and keeps gaps out of the recording', () => {
    const records = [record(1, '2026-06-04T22:00:00Z', '2026-06-05T01:00:00Z'),
      record(2, '2026-06-05T00:00:00Z', '2026-06-05T03:00:00Z'),
      record(3, '2026-06-05T04:00:00Z', '2026-06-05T06:00:00Z')]
    expect(recordingWindows(records)).toHaveLength(2)
    expect(summarizeRecording(records, 'UTC')).toMatchObject({ durationMs: 7 * 3600000, gapsMs: 3600000 })
  })

  it('uses Pod-local noon across the repeated DST hour, independently of the browser zone', () => {
    expect(sleepNightKey(new Date('2026-11-01T08:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-31')
    expect(sleepNightKey(new Date('2026-11-01T09:30:00Z'), 'America/Los_Angeles')).toBe('2026-10-31')
    expect(sleepNightKey(new Date('2026-11-01T19:59:59Z'), 'America/Los_Angeles')).toBe('2026-10-31')
    expect(sleepNightKey(new Date('2026-11-01T20:00:00Z'), 'America/Los_Angeles')).toBe('2026-11-01')
    expect(sleepNightKey(new Date('2026-06-04T13:00:00Z'), 'Asia/Tokyo')).toBe('2026-06-04')
  })

  it('selects an explicit older night and returns empty for an absent night', () => {
    const records = [record(1, '2026-06-03T22:00:00Z', '2026-06-04T06:00:00Z'), record(2, '2026-06-04T22:00:00Z', '2026-06-05T06:00:00Z')]
    expect(selectNightRecords(records, 'UTC', '2026-06-03').map(value => value.id)).toEqual([1])
    expect(selectNightRecords(records, 'UTC', '2026-06-02')).toEqual([])
    expect(summarizeRecording([], 'UTC')).toBeNull()
  })

  it('bounds an open session at the supplied current time and excludes malformed windows', () => {
    const start = new Date('2026-06-04T22:00:00Z'), now = new Date('2026-06-05T01:00:00Z')
    expect(recordingWindows([{ id: 1, enteredBedAt: start, leftBedAt: null },
      record(2, 'invalid', '2026-06-05T03:00:00Z')], now)).toEqual([{ start, end: now }])
  })
})
