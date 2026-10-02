import { describe, expect, it } from 'vitest'
import {
  formatCountdown,
  formatSleepDuration,
  nextSetPoint,
  offsetLabel,
  pickAlarmGroup,
  stepTargetF,
  summarizeDays,
  tonightPlan,
  type AlarmRow,
  type TempPointRow,
} from '../tempScreenUtils'

// Wednesday 2026-09-23 22:00 local
const WED_22 = new Date(2026, 8, 23, 22, 0, 0)

describe('stepTargetF', () => {
  it('steps one degree in °F and clamps to 55–110', () => {
    expect(stepTargetF(76, 1, 'F')).toBe(77)
    expect(stepTargetF(76, -1, 'F')).toBe(75)
    expect(stepTargetF(110, 1, 'F')).toBe(110)
    expect(stepTargetF(55, -1, 'F')).toBe(55)
  })

  it('steps one display degree for °C users and returns whole °F', () => {
    // 80°F = 26.67°C → 27.67°C = 81.8°F → 82
    expect(stepTargetF(80, 1, 'C')).toBe(82)
    expect(stepTargetF(80, -1, 'C')).toBe(78)
  })
})

describe('offsetLabel', () => {
  it('formats the offset from 80 with a true minus sign', () => {
    expect(offsetLabel(76, 'F')).toBe('−4')
    expect(offsetLabel(82, 'F')).toBe('+2')
    expect(offsetLabel(80, 'F')).toBe('0')
  })

  it('uses display-unit degrees for °C', () => {
    expect(offsetLabel(89, 'C')).toBe('+5')
  })
})

describe('nextSetPoint', () => {
  const points: TempPointRow[] = [
    { dayOfWeek: 'wednesday', time: '21:00', temperature: 70, enabled: true },
    { dayOfWeek: 'wednesday', time: '23:30', temperature: 72, enabled: true },
    { dayOfWeek: 'wednesday', time: '22:30', temperature: 60, enabled: false },
    { dayOfWeek: 'thursday', time: '01:00', temperature: 68, enabled: true },
  ]

  it('picks the soonest enabled occurrence after now', () => {
    const next = nextSetPoint(points, WED_22)
    expect(next?.time).toBe('23:30')
    expect(next?.temperature).toBe(72)
    expect((next?.at.getTime() ?? 0) - WED_22.getTime()).toBe(90 * 60_000)
  })

  it('wraps to next week for a same-day time already passed', () => {
    const next = nextSetPoint([points[0]], WED_22)
    expect(next?.at.getDate()).toBe(30)
    expect(next?.at.getHours()).toBe(21)
  })

  it('returns null when nothing is enabled', () => {
    expect(nextSetPoint([points[2]], WED_22)).toBeNull()
  })
})

describe('tonightPlan', () => {
  const temps: TempPointRow[] = [
    { dayOfWeek: 'wednesday', time: '06:30', temperature: 80, enabled: true },
    { dayOfWeek: 'wednesday', time: '22:00', temperature: 75, enabled: true },
    { dayOfWeek: 'wednesday', time: '02:00', temperature: 70, enabled: true },
    { dayOfWeek: 'wednesday', time: '03:00', temperature: 99, enabled: false },
    { dayOfWeek: 'tuesday', time: '22:00', temperature: 60, enabled: true },
  ]

  it('orders tonight’s enabled points across midnight and uses them as the window without a power schedule', () => {
    const plan = tonightPlan(temps, [], WED_22)
    expect(plan.points.map(p => p.temperature)).toEqual([75, 70, 80])
    expect(plan.window).toEqual({ start: '22:00', end: '06:30' })
  })

  it('prefers the enabled power schedule window', () => {
    const plan = tonightPlan(temps, [
      { dayOfWeek: 'wednesday', onTime: '23:15', offTime: '07:00', enabled: true },
      { dayOfWeek: 'wednesday', onTime: '20:00', offTime: '05:00', enabled: false },
    ], WED_22)
    expect(plan.window).toEqual({ start: '23:15', end: '07:00' })
  })

  it('treats before 4 AM as the previous night', () => {
    const plan = tonightPlan(temps, [], new Date(2026, 8, 24, 2, 0))
    expect(plan.points.map(p => p.temperature)).toEqual([75, 70, 80])
  })

  it('has no window with fewer than two points and no power schedule', () => {
    expect(tonightPlan([temps[4]], [], WED_22).window).toBeNull()
  })
})

describe('formatters', () => {
  it('formats countdowns', () => {
    expect(formatCountdown(30_000)).toBe('<1m')
    expect(formatCountdown(51 * 60_000)).toBe('51m')
    expect(formatCountdown(125 * 60_000)).toBe('2h 5m')
    expect(formatCountdown(120 * 60_000)).toBe('2h')
  })

  it('formats sleep durations', () => {
    expect(formatSleepDuration(45 * 60)).toBe('45m')
    expect(formatSleepDuration(7 * 3600 + 9 * 60)).toBe('7h 9m')
    expect(formatSleepDuration(8 * 3600)).toBe('8h')
  })

  it('summarizes day sets', () => {
    expect(summarizeDays(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])).toBe('Daily')
    expect(summarizeDays(['friday', 'monday', 'tuesday', 'wednesday', 'thursday'])).toBe('Weekdays')
    expect(summarizeDays(['sunday', 'saturday'])).toBe('Weekends')
    expect(summarizeDays(['sunday', 'wednesday', 'monday'])).toBe('Mon, Wed, Sun')
    expect(summarizeDays(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'])).toBe('Mon–Sat')
    expect(summarizeDays(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'])).toBe('Sun–Thu')
    expect(summarizeDays(['monday', 'tuesday', 'wednesday', 'friday'])).toBe('Mon–Wed, Fri')
    expect(summarizeDays(['tuesday', 'thursday', 'saturday'])).toBe('Tue, Thu, Sat')
    expect(summarizeDays(['saturday', 'sunday', 'monday'])).toBe('Sat–Mon')
    expect(summarizeDays(['saturday', 'sunday', 'monday', 'wednesday'])).toBe('Sat–Mon, Wed')
  })
})

describe('pickAlarmGroup', () => {
  const alarm = (id: number, dayOfWeek: AlarmRow['dayOfWeek'], time: string, enabled: boolean): AlarmRow =>
    ({ id, dayOfWeek, time, duration: 10, enabled })

  it('groups by time and picks the next enabled occurrence', () => {
    const group = pickAlarmGroup([
      alarm(1, 'thursday', '06:45', true),
      alarm(2, 'friday', '06:45', true),
      alarm(3, 'saturday', '06:45', false),
      alarm(4, 'thursday', '05:00', false),
      alarm(5, 'saturday', '09:00', true),
    ], WED_22)
    expect(group?.time).toBe('06:45')
    expect(group?.enabled).toBe(true)
    expect(group?.rows.map(r => r.id)).toEqual([1, 2, 3])
    expect(group?.days).toEqual(['thursday', 'friday'])
    expect(group?.duration).toBe(10)
  })

  it('falls back to the next occurrence of any alarm when none are enabled', () => {
    const group = pickAlarmGroup([alarm(1, 'friday', '07:00', false), alarm(2, 'thursday', '05:00', false)], WED_22)
    expect(group?.time).toBe('05:00')
    expect(group?.enabled).toBe(false)
  })

  it('keeps a pinned group on screen after it is switched off', () => {
    const rows = [alarm(1, 'thursday', '06:45', false), alarm(2, 'friday', '07:30', true)]
    expect(pickAlarmGroup(rows, WED_22)?.time).toBe('07:30')
    expect(pickAlarmGroup(rows, WED_22, '06:45')?.time).toBe('06:45')
    expect(pickAlarmGroup(rows, WED_22, '11:11')?.time).toBe('07:30')
  })

  it('returns null without alarms', () => {
    expect(pickAlarmGroup([], WED_22)).toBeNull()
  })
})
