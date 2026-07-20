import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('rejects an invalid hour or minute independently', () => {
    expect(Number.isNaN(hhmmToMinutes('bad:30'))).toBe(true)
    expect(Number.isNaN(hhmmToMinutes('12:bad'))).toBe(true)
    expect(hhmmToMinutes('12:34')).toBe(12 * 60 + 34)
  })

  it('formats HH:mm as 12-hour time', () => {
    expect(formatTime12h('00:00')).toBe('12:00 AM')
    expect(formatTime12h('12:00')).toBe('12:00 PM')
    expect(formatTime12h('23:45')).toBe('11:45 PM')
    expect(formatTime12h('04')).toBe('4:00 AM')
    expect(formatTime12h('not-a-time')).toBe('not-a-time')
  })

  it('calculates wrapped and same-day durations', () => {
    expect(calcDuration('07:00', '09:30')).toBe('2h 30m')
    expect(calcDuration('22:00', '07:00')).toBe('9h 0m')
    expect(calcDuration('bad', '07:00')).toBe('—')
    expect(calcDuration('07:00', 'bad:00')).toBe('—')
    expect(calcDuration('07:00', '07:00')).toBe('0h 0m')
  })

  it('checks same-day and overnight windows', () => {
    expect(isInWindow(8 * 60, '07:00', '09:00')).toBe(true)
    expect(isInWindow(22 * 60, '07:00', '09:00')).toBe(false)
    expect(isInWindow(23 * 60, '22:00', '07:00')).toBe(true)
    expect(isInWindow(6 * 60, '22:00', '07:00')).toBe(true)
    expect(isInWindow(12 * 60, '22:00', '07:00')).toBe(false)
  })

  it('uses inclusive starts and exclusive ends for both window shapes', () => {
    expect(isInWindow(7 * 60, '07:00', '09:00')).toBe(true)
    expect(isInWindow(9 * 60, '07:00', '09:00')).toBe(false)
    expect(isInWindow(22 * 60, '22:00', '07:00')).toBe(true)
    expect(isInWindow(7 * 60, '22:00', '07:00')).toBe(false)
    expect(isInWindow(7 * 60, '07:00', '07:00')).toBe(false)
  })

  it('rejects each invalid window input independently', () => {
    expect(isInWindow(Number.NaN, '07:00', '09:00')).toBe(false)
    expect(isInWindow(8 * 60, 'bad:00', '09:00')).toBe(false)
    expect(isInWindow(8 * 60, '07:00', 'bad:00')).toBe(false)
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

  it('keeps the current timezone day at exactly 04:00', () => {
    const fourAmLa = new Date('2026-07-01T11:00:00.000Z')
    expect(getCurrentDayForTimezone('America/Los_Angeles', fourAmLa)).toBe('wednesday')
  })

  it('uses the timezone-local hour and minute exactly', () => {
    const now = new Date('2026-07-01T04:37:00.000Z')
    expect(isInWindowForTimezone('04:37', '04:38', 'UTC', now)).toBe(true)
    expect(isInWindowForTimezone('04:36', '04:37', 'UTC', now)).toBe(false)
  })

  it('reports the custom invalid-timezone result when Intl yields no known weekday', () => {
    const FakeDateTimeFormat = function () {
      return {
        formatToParts: () => [
          { type: 'weekday', value: 'Funday' },
          { type: 'hour', value: '05' },
        ],
      }
    } as unknown as typeof Intl.DateTimeFormat
    vi.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(FakeDateTimeFormat)

    expect(() => getCurrentDayForTimezone('Fake/Zone')).toThrow('Invalid timezone: Fake/Zone')
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
