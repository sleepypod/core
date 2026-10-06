import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DemoHandlers, RouterInputs } from '../types'

let schedules: DemoHandlers<'schedules'>

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

beforeEach(async () => {
  vi.resetModules()
  ;({ schedules } = await import('../handlers/schedules'))
})

const alarm: RouterInputs['schedules']['createAlarmSchedule'] = {
  side: 'left', dayOfWeek: 'monday', time: '06:30',
  vibrationIntensity: 40, duration: 60, alarmTemperature: 78,
}

const cases = [
  { name: 'defaults', settings: {}, expected: { vibrationPattern: 'rise', wakeWindow: 0, enabled: true } },
  { name: 'explicit window', settings: { vibrationPattern: 'double' as const, wakeWindow: 20, enabled: false }, expected: { vibrationPattern: 'double', wakeWindow: 20, enabled: false } },
  { name: 'explicit zero', settings: { vibrationPattern: 'rise' as const, wakeWindow: 0, enabled: true }, expected: { vibrationPattern: 'rise', wakeWindow: 0, enabled: true } },
]

describe('demo alarm schedules', () => {
  it('leaves alarms untouched when a batch omits alarm creates', async () => {
    const before = await required(schedules.getAll)({ side: 'left' })
    expect(await required(schedules.batchUpdate)({ creates: {} })).toEqual({ success: true })
    const after = await required(schedules.getAll)({ side: 'left' })
    expect(after.alarm).toEqual(before.alarm)
  })

  it.each(cases)('persists $name on individual creation', async ({ settings, expected }) => {
    const created = await required(schedules.createAlarmSchedule)({ ...alarm, ...settings })
    expect(created).toMatchObject({ ...alarm, ...expected })
    const saved = await required(schedules.getAll)({ side: 'left' })
    expect(saved.alarm.find(row => row.id === created.id)).toEqual(created)
  })

  it.each(cases)('persists $name on batch creation', async ({ settings, expected }) => {
    const before = await required(schedules.getAll)({ side: 'left' })
    const ids = new Set(before.alarm.map(row => row.id))
    expect(await required(schedules.batchUpdate)({ creates: { alarm: [{ ...alarm, ...settings }] } })).toEqual({ success: true })
    const after = await required(schedules.getAll)({ side: 'left' })
    const added = after.alarm.filter(row => !ids.has(row.id))
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ ...alarm, ...expected })
  })
})
