import { describe, expect, it } from 'vitest'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { comfortRoutineAt, type ComfortSchedules } from '../routines'

function schedules(): ComfortSchedules {
  return { timezone: 'America/Los_Angeles',
    powers: DAYS_OF_WEEK.map((dayOfWeek, index) => ({ id: index, dayOfWeek, onTime: '22:00', offTime: '07:00', onTemperature: 75 })),
    targets: [{ id: 8, dayOfWeek: 'sunday', time: '01:00', temperature: 73 }],
    alarms: [{ id: 9, dayOfWeek: 'sunday', time: '06:30' }],
  }
}

describe('personal comfort schedule adapter', () => {
  it('uses actual next-day end events and current intermediate targets', () => {
    const result = comfortRoutineAt(schedules(), Date.parse('2026-10-25T09:00:00Z'))
    expect(result).toMatchObject({ start: Date.parse('2026-10-25T05:00:00Z'), end: Date.parse('2026-10-25T14:00:00Z'), baselineF: 73, alarmAt: Date.parse('2026-10-25T13:30:00Z') })
  })

  it.each([
    ['2026-03-08T09:30:00Z', '2026-03-08T06:00:00Z', '2026-03-08T14:00:00Z'],
    ['2026-11-01T10:30:00Z', '2026-11-01T05:00:00Z', '2026-11-01T15:00:00Z'],
  ])('keeps local routine boundaries through DST at %s', (now, start, end) => {
    expect(comfortRoutineAt(schedules(), Date.parse(now))).toMatchObject({ start: Date.parse(start), end: Date.parse(end) })
  })

  it('does not invent Sunday OFF for a Saturday-only overnight row', () => {
    const input = schedules()
    input.powers = input.powers.filter(row => row.dayOfWeek === 'saturday')
    expect(comfortRoutineAt(input, Date.parse('2026-10-25T06:00:00Z'))).toBeNull()
  })

  it.each([
    ['2026-10-25T09:00:00Z', '2026-10-25T05:00:00Z', '2026-10-25T14:00:00Z'],
    ['2026-03-08T09:30:00Z', '2026-03-08T06:00:00Z', '2026-03-08T14:00:00Z'],
    ['2026-11-01T10:30:00Z', '2026-11-01T05:00:00Z', '2026-11-01T15:00:00Z'],
  ])('uses an explicitly imported Saturday overnight window through week-wrap/DST at %s', (now, start, end) => {
    const input = schedules()
    input.powers = input.powers.filter(row => row.dayOfWeek === 'saturday').map(row => ({ ...row, offDayOffset: 1 }))
    expect(comfortRoutineAt(input, Date.parse(now))).toMatchObject({ start: Date.parse(start), end: Date.parse(end), baselineF: 73 })
    expect(comfortRoutineAt(input, Date.parse(end))).toBeNull()
  })

  it('withholds overlapping starts, duplicate starts, equal boundaries and malformed clocks', () => {
    for (const onTime of ['21:30', '22:00', '07:00', '99:00']) {
      const input = schedules()
      input.powers.push({ id: 20, dayOfWeek: 'saturday', onTime, offTime: '07:00', onTemperature: 75 })
      expect(comfortRoutineAt(input, Date.parse('2026-10-25T06:00:00Z'))).toBeNull()
    }
  })

  it('uses the same simultaneous power/temperature tie as shared arbitration', () => {
    const input = schedules()
    input.targets.push({ id: 20, dayOfWeek: 'saturday', time: '22:00', temperature: 80 })
    expect(comfortRoutineAt(input, Date.parse('2026-10-25T05:00:00Z'))?.baselineF).toBe(75)
  })

  it('withdraws exactly at the end and outside any bounded window', () => {
    expect(comfortRoutineAt(schedules(), Date.parse('2026-10-25T14:00:00Z'))).toBeNull()
    expect(comfortRoutineAt(schedules(), Date.parse('2026-10-25T20:00:00Z'))).toBeNull()
    expect(comfortRoutineAt({ ...schedules(), timezone: 'bad-zone' }, Date.now())).toBeNull()
    expect(comfortRoutineAt(schedules(), NaN)).toBeNull()
  })
})
