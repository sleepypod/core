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

it('pads a single-digit schedule hour and preserves invalid values in both formats', () => {
  expect(formatTime('7:05', '24h')).toBe('07:05')
  expect(formatTime('7:05')).toBe('7:05 AM')
  for (const value of ['-1:00', '123:00', '12:5', '12:00:00', '23:60']) {
    expect(formatTime(value)).toBe(value)
    expect(formatTime(value, '24h')).toBe(value)
  }
})

it('supports string and epoch clocks, missing values, and hour-only labels', () => {
  const value = '2026-10-06T07:05:09Z'
  expect(formatClock(value, '24h', { timeZone: 'UTC' })).toBe('07:05')
  expect(formatClock(Date.parse(value), '12h', { timeZone: 'UTC' })).toBe('7:05 AM')
  expect(formatClock(undefined)).toBe('—')
  expect(formatClock(value, '12h', { hour: 'numeric', timeZone: 'UTC' })).toBe('7 AM')
  expect(formatClock(value, '12h', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })).toBe('07:05 AM')
  expect(formatClock(value, '24h', { hour: 'numeric', timeZone: 'UTC' })).toBe('07:05')
})

it('keeps nonzero minutes in 12-hour and 24-hour chart ticks', () => {
  const value = new Date(2026, 9, 6, 23, 5).getTime()
  expect(formatTick(value)).toBe('11:05 PM')
  expect(formatTick(value, '24h')).toBe('23:05')
})
