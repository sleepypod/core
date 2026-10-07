import { describe, expect, it } from 'vitest'
import { formatClock, formatTick, formatTime } from '../timeFormat'

describe('clock display formats', () => {
  it.each([
    ['00:00', '12:00 AM', '00:00'],
    ['07:05', '7:05 AM', '07:05'],
    ['12:00', '12:00 PM', '12:00'],
    ['13:30', '1:30 PM', '13:30'],
    ['23:59', '11:59 PM', '23:59'],
  ])('formats %s without changing the schedule value', (value, twelve, twentyFour) => {
    expect(formatTime(value)).toBe(twelve)
    expect(formatTime(value, '24h')).toBe(twentyFour)
  })
  it.each(['', 'invalid', '24:00', '12:60'])('preserves invalid input %j', (value) => {
    expect(formatTime(value, '24h')).toBe(value)
  })
  it('uses 00 at midnight, includes seconds when requested, and honors the timezone', () => {
    const date = new Date('2026-10-06T00:05:09Z')
    expect(formatClock(date, '24h', { timeZone: 'UTC', second: '2-digit' })).toBe('00:05:09')
    expect(formatClock(date, '12h', { timeZone: 'UTC' })).toBe('12:05 AM')
    expect(formatClock(date, '24h', { timeZone: 'America/Los_Angeles' })).toBe('17:05')
    expect(formatClock(null, '24h')).toBe('—')
  })
  it('keeps minutes on 24-hour axis ticks, including at midnight and noon', () => {
    for (const hour of [0, 12, 23]) {
      const time = new Date(2026, 9, 6, hour, 0).getTime()
      expect(formatTick(time, '24h')).toBe(`${String(hour).padStart(2, '0')}:00`)
    }
    expect(formatTick(new Date(2026, 9, 6, 23, 0).getTime())).toBe('11 PM')
  })
})
