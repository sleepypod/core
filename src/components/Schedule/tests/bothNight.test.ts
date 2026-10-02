import { describe, expect, it } from 'vitest'
import { formatCountdown, formatNightDates, nextSetPoint, nightDate, nightSetPoints, nightWindow } from '../bothNight'

const row = (dayOfWeek: string, time: string, temperature: number, enabled = true) => ({ dayOfWeek, time, temperature, enabled })
// Monday Sep 28 2026, 5:54 PM local
const NOW = new Date(2026, 8, 28, 17, 54)

describe('bothNight', () => {
  it('picks enabled set points saved under the day', () => {
    const temps = [row('monday', '23:15', 80), row('monday', '07:00', 82, false), row('tuesday', '22:00', 78)]
    expect(nightSetPoints(temps, 'monday')).toEqual([{ time: '23:15', temperature: 80 }])
    expect(nightSetPoints(undefined, 'monday')).toEqual([])
  })

  it('finds the next occurrence of a weekday, today included', () => {
    expect(nightDate('monday', NOW)).toEqual(new Date(2026, 8, 28))
    expect(nightDate('sunday', NOW)).toEqual(new Date(2026, 9, 4))
  })

  it('places an overnight window on the following morning', () => {
    const w = nightWindow([{ time: '23:15', temperature: 80 }, { time: '07:00', temperature: 82 }], new Date(2026, 8, 28))
    expect(w?.start).toEqual(new Date(2026, 8, 28, 23, 15))
    expect(w?.end).toEqual(new Date(2026, 8, 29, 7, 0))
    expect(nightWindow([], new Date(2026, 8, 28))).toBeNull()
  })

  it('finds the soonest set point, counting last night’s post-midnight points', () => {
    const temps = [row('sunday', '23:00', 79), row('sunday', '19:00', 81), row('monday', '23:15', 80)]
    // Sunday 19:00 → 23:00 stays on Sunday evening, so the next point is Monday 23:15.
    expect(nextSetPoint(temps, NOW)).toMatchObject({ time: '23:15', temperature: 80 })
    const early = new Date(2026, 8, 28, 3, 0)
    const overnight = [row('sunday', '23:00', 79), row('sunday', '06:30', 84)]
    expect(nextSetPoint(overnight, early)).toMatchObject({ time: '06:30', at: new Date(2026, 8, 28, 6, 30) })
    expect(nextSetPoint([], NOW)).toBeNull()
  })

  it('formats countdowns and night dates', () => {
    expect(formatCountdown((5 * 60 + 21) * 60_000)).toBe('5h 21m')
    expect(formatCountdown(45 * 60_000)).toBe('45m')
    expect(formatNightDates(new Date(2026, 8, 28))).toBe('Sep 28 → 29')
    expect(formatNightDates(new Date(2026, 8, 30))).toBe('Sep 30 → Oct 1')
  })
})
