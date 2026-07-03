import { describe, expect, it } from 'vitest'
import {
  calcDuration,
  formatTime12h,
  getCurrentDay,
  getCurrentDayForTimezone,
  hhmmToMinutes,
  isInWindow,
  isInWindowForTimezone,
} from '../scheduleTime'

describe('scheduleTime', () => {
  it('converts HH:mm strings to minutes', () => {
    expect(hhmmToMinutes('00:00')).toBe(0)
    expect(hhmmToMinutes('23:59')).toBe(1439)
    expect(Number.isNaN(hhmmToMinutes('bad'))).toBe(true)
  })

  it('formats HH:mm as 12-hour time', () => {
    expect(formatTime12h('00:00')).toBe('12:00 AM')
    expect(formatTime12h('12:00')).toBe('12:00 PM')
    expect(formatTime12h('23:45')).toBe('11:45 PM')
  })

  it('calculates wrapped and same-day durations', () => {
    expect(calcDuration('07:00', '09:30')).toBe('2h 30m')
    expect(calcDuration('22:00', '07:00')).toBe('9h 0m')
    expect(calcDuration('bad', '07:00')).toBe('—')
  })

  it('checks same-day and overnight windows', () => {
    expect(isInWindow(8 * 60, '07:00', '09:00')).toBe(true)
    expect(isInWindow(22 * 60, '07:00', '09:00')).toBe(false)
    expect(isInWindow(23 * 60, '22:00', '07:00')).toBe(true)
    expect(isInWindow(6 * 60, '22:00', '07:00')).toBe(true)
    expect(isInWindow(12 * 60, '22:00', '07:00')).toBe(false)
  })

  it('treats local pre-4am as the previous schedule day', () => {
    expect(getCurrentDay(new Date(2026, 6, 1, 3, 59))).toBe('tuesday')
    expect(getCurrentDay(new Date(2026, 6, 1, 4, 0))).toBe('wednesday')
  })

  it('checks a timezone-aware wrapped night window across DST dates', () => {
    const beforeSpringForward = new Date('2026-03-08T09:30:00.000Z') // 01:30 America/Los_Angeles
    const afterSpringForward = new Date('2026-03-08T10:30:00.000Z') // 03:30 America/Los_Angeles
    expect(isInWindowForTimezone('22:00', '07:00', 'America/Los_Angeles', beforeSpringForward)).toBe(true)
    expect(isInWindowForTimezone('22:00', '07:00', 'America/Los_Angeles', afterSpringForward)).toBe(true)
  })

  it('gets the schedule day in a timezone', () => {
    const earlyLa = new Date('2026-07-01T10:30:00.000Z') // 03:30 Wednesday America/Los_Angeles
    expect(getCurrentDayForTimezone('America/Los_Angeles', earlyLa)).toBe('tuesday')
  })
})
