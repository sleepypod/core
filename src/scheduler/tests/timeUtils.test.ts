import { describe, it, expect } from 'vitest'
import { timeToDate, nowInTimezone } from '../timeUtils'

describe('timeToDate', () => {
  it('returns same-day instant when target time is later today in the zone', () => {
    // Reference: 2026-04-01 14:00 UTC (which is 10:00 EDT / -04:00)
    const ref = new Date('2026-04-01T14:00:00Z')
    // 12:30 EDT is 16:30 UTC
    const result = timeToDate('12:30', 'America/New_York', ref)
    expect(result.toISOString()).toBe('2026-04-01T16:30:00.000Z')
  })

  it('rolls to tomorrow when target time already passed today in the zone', () => {
    // Reference: 2026-04-01 14:00 UTC (10:00 EDT)
    const ref = new Date('2026-04-01T14:00:00Z')
    // 08:00 EDT has already passed -> 2026-04-02 08:00 EDT = 2026-04-02 12:00 UTC
    const result = timeToDate('08:00', 'America/New_York', ref)
    expect(result.toISOString()).toBe('2026-04-02T12:00:00.000Z')
  })

  it('uses the calendar date of the reference *in the target zone*', () => {
    // Reference: 2026-04-01 02:00 UTC, which is still 2026-03-31 22:00 EDT
    const ref = new Date('2026-04-01T02:00:00Z')
    // 23:00 on 2026-03-31 EDT = 2026-04-01 03:00 UTC (later than ref, so same zone-day)
    const result = timeToDate('23:00', 'America/New_York', ref)
    expect(result.toISOString()).toBe('2026-04-01T03:00:00.000Z')
  })

  it('handles DST spring-forward gap by returning a valid instant past the gap', () => {
    // US spring-forward 2026: 02:00 -> 03:00 local on 2026-03-08.
    // 02:30 on that day does not exist in America/New_York.
    // Reference: just before midnight local (prev day)
    const ref = new Date('2026-03-08T06:00:00Z') // 01:00 EST
    const result = timeToDate('02:30', 'America/New_York', ref)
    // The old toLocaleString-based path produced an inconsistent offset here;
    // with the formatToParts approach we get a single, well-defined instant.
    // 02:30 in the pre-transition offset (-05:00) = 07:30 UTC.
    // After our forward correction, the returned instant maps to 03:30 EDT = 07:30 UTC,
    // i.e. the first valid local time after the skipped 02:30 slot.
    expect(result.toISOString()).toBe('2026-03-08T07:30:00.000Z')
    // Sanity: the returned Date is strictly after the reference (not a no-op).
    expect(result.getTime()).toBeGreaterThan(ref.getTime())
  })

  it('handles DST fall-back by resolving to the first occurrence of the ambiguous time', () => {
    // US fall-back 2026: 02:00 EDT -> 01:00 EST on 2026-11-01
    // 01:30 local is ambiguous (occurs twice). We pick the pre-transition (EDT) instance.
    const ref = new Date('2026-11-01T04:00:00Z') // 00:00 EDT
    const result = timeToDate('01:30', 'America/New_York', ref)
    // 01:30 EDT (-04:00) = 05:30 UTC
    expect(result.toISOString()).toBe('2026-11-01T05:30:00.000Z')
  })

  it('handles UTC timezone correctly', () => {
    const ref = new Date('2026-04-01T12:00:00Z')
    const result = timeToDate('15:00', 'UTC', ref)
    expect(result.toISOString()).toBe('2026-04-01T15:00:00.000Z')
  })

  it('rolls to tomorrow at midnight-edge correctly across DST start', () => {
    // Reference: 2026-03-08 05:00 UTC = 2026-03-08 00:00 EST (just after midnight local)
    // Request 00:00 -> should be equal to ref-ish; since adjusted <= ref (equal), rolls to tomorrow
    const ref = new Date('2026-03-08T05:00:00Z')
    const result = timeToDate('00:00', 'America/New_York', ref)
    // Tomorrow 00:00 EDT (after DST kicked in mid-day) = 2026-03-09 00:00 EDT = 04:00 UTC
    expect(result.toISOString()).toBe('2026-03-09T04:00:00.000Z')
  })

  it('throws on invalid time format', () => {
    const ref = new Date('2026-04-01T12:00:00Z')
    expect(() => timeToDate('abc', 'UTC', ref)).toThrow('Invalid time format')
  })

  it('throws on invalid timezone', () => {
    const ref = new Date('2026-04-01T12:00:00Z')
    expect(() => timeToDate('12:00', 'Not/A_Zone', ref)).toThrow()
  })
})

describe('nowInTimezone', () => {
  it('returns wall-clock hour/minute in the target zone, not the OS zone', () => {
    // 2026-04-01 14:30 UTC
    const now = new Date('2026-04-01T14:30:00Z')
    // 10:30 EDT
    expect(nowInTimezone('America/New_York', now)).toEqual({ hour: 10, minute: 30 })
    // 06:30 PDT
    expect(nowInTimezone('America/Los_Angeles', now)).toEqual({ hour: 7, minute: 30 })
    // 14:30 UTC
    expect(nowInTimezone('UTC', now)).toEqual({ hour: 14, minute: 30 })
  })

  it('correctly handles the day boundary in the target zone', () => {
    // 2026-04-01 02:00 UTC = 2026-03-31 22:00 EDT (previous day)
    const now = new Date('2026-04-01T02:00:00Z')
    expect(nowInTimezone('America/New_York', now)).toEqual({ hour: 22, minute: 0 })
  })

  it('uses h23 cycle (0-23, not 1-24)', () => {
    // 2026-04-01 04:00 UTC = 2026-04-01 00:00 EDT (midnight)
    const now = new Date('2026-04-01T04:00:00Z')
    expect(nowInTimezone('America/New_York', now)).toEqual({ hour: 0, minute: 0 })
  })

  it('throws on invalid timezone', () => {
    expect(() => nowInTimezone('Not/A_Zone', new Date())).toThrow()
  })
})
