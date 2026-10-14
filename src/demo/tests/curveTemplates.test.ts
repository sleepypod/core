import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DemoHandlers, RouterInputs } from '../types'

let curveTemplates: DemoHandlers<'curveTemplates'>
let schedules: DemoHandlers<'schedules'>

function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}

beforeEach(async () => {
  vi.resetModules()
  ;({ curveTemplates } = await import('../handlers/curveTemplates'))
  ;({ schedules } = await import('../handlers/schedules'))
})

const list = () => required(curveTemplates.list)({})
const curve = async (name: string) => {
  const found = (await list()).find(t => t.name === name)
  if (!found) throw new Error(`no ${name}`)
  return found
}
const rows = async (side: 'left' | 'right', day: string) => {
  const all = await required(schedules.getAll)({ side })
  return {
    temperature: all.temperature.filter(r => r.dayOfWeek === day).map(r => `${r.time}@${r.temperature}`).sort(),
    power: all.power.filter(r => r.dayOfWeek === day),
  }
}
const HEATWAVE: Omit<RouterInputs['curveTemplates']['put'], 'days' | 'active'> = {
  name: 'Heatwave', bedtime: '22:00', wake: '06:30', points: { '22:00': 66, '23:00': 62, '03:00': 64, '06:30': 72 }, notes: 'Hot week',
}

describe('demo schedule library', () => {
  it('seeds the demo schedules as active curves plus one that is off', async () => {
    const curves = await list()
    expect(curves.map(c => [c.name, c.active, c.days])).toEqual(expect.arrayContaining([
      ['Cool weeknights', true, { left: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'], right: [] }],
      ['Cool weekends', true, { left: ['friday', 'saturday'], right: [] }],
      ['Warm weeknights', true, { left: [], right: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday'] }],
      ['Warm weekends', true, { left: [], right: ['friday', 'saturday'] }],
      ['Heatwave', false, { left: [], right: [] }],
    ]))
    expect(curves).toHaveLength(5)
  })

  it('refuses to turn on a curve without days', async () => {
    const heatwave = await curve('Heatwave')
    expect(() => required(curveTemplates.setActive)({ id: heatwave.id, active: true })).toThrow('Pick days for Heatwave')
    expect(() => required(curveTemplates.setActive)({ id: 999, active: true })).toThrow('No curve with id 999')
  })

  it('moves days from the curve running them and writes the rows', async () => {
    const heatwave = await curve('Heatwave')
    const result = await required(curveTemplates.put)({ ...HEATWAVE, id: heatwave.id, days: { left: ['monday', 'tuesday'] }, active: true })
    expect(result.moved).toEqual([{ name: 'Cool weeknights', side: 'left', days: ['monday', 'tuesday'], deactivated: false }])
    expect(result.curve).toMatchObject({ active: true, days: { left: ['monday', 'tuesday'], right: [] } })
    expect((await curve('Cool weeknights')).days.left).toEqual(['sunday', 'wednesday', 'thursday'])

    const monday = await rows('left', 'monday')
    expect(monday.temperature).toEqual(['03:00@64', '06:30@72', '22:00@66', '23:00@62'])
    expect(monday.power).toMatchObject([{ onTime: '22:00', offTime: '06:30', onTemperature: 66, endAction: 'turn_off' }])
    expect((await required(schedules.getNotes)({ side: 'left' })).filter(n => n.dayOfWeek === 'monday')).toEqual([{ dayOfWeek: 'monday', notes: 'Hot week' }])

    await required(curveTemplates.setActive)({ id: heatwave.id, active: false })
    expect(await rows('left', 'monday')).toEqual({ temperature: [], power: [] })
    expect((await curve('Heatwave')).days.left).toEqual(['monday', 'tuesday'])
    expect(await required(curveTemplates.setActive)({ id: heatwave.id, active: false })).toMatchObject({ moved: [] })
  })

  it('turns off a curve that gives up all its days', async () => {
    const result = await required(curveTemplates.put)({ ...HEATWAVE, days: { right: ['friday', 'saturday'] }, active: true, name: 'Weekend heat' })
    expect(result.moved).toEqual([{ name: 'Warm weekends', side: 'right', days: ['friday', 'saturday'], deactivated: true }])
    expect(await curve('Warm weekends')).toMatchObject({ active: false, days: { left: [], right: [] } })
  })

  it('saves a curve without days off, and rejects duplicate names and unknown ids', async () => {
    const result = await required(curveTemplates.put)({ ...HEATWAVE, name: 'Later', days: {}, active: true })
    expect(result.curve).toMatchObject({ active: false, days: { left: [], right: [] } })
    expect(() => required(curveTemplates.put)({ ...HEATWAVE, days: {}, active: false })).toThrow('Another curve already has that name')
    expect(() => required(curveTemplates.put)({ ...HEATWAVE, id: 999, name: 'X', days: {}, active: false })).toThrow('No curve with id 999')
  })

  it('save rewrites an active curve by name and stores a new one off', async () => {
    await required(curveTemplates.save)({ name: 'Cool weekends', bedtime: '23:00', wake: '07:00', points: { '23:00': 70, '07:00': 78 }, endAction: 'maintain' })
    expect((await rows('left', 'friday')).temperature).toEqual(['07:00@78', '23:00@70'])
    expect((await rows('left', 'friday')).power).toMatchObject([{ endAction: 'maintain' }])

    const created = await required(curveTemplates.save)({ name: 'New one', bedtime: '22:00', wake: '06:00', points: { '22:00': 70, '06:00': 80 } })
    expect(created).toMatchObject({ active: false, endAction: 'turn_off', notes: '', days: { left: [], right: [] } })
  })

  it('delete clears an active curve\'s days', async () => {
    expect(await required(curveTemplates.delete)({ name: 'Cool weekends' })).toEqual({ deleted: true })
    expect(await rows('left', 'saturday')).toEqual({ temperature: [], power: [] })
    expect(await required(curveTemplates.delete)({ name: 'Cool weekends' })).toEqual({ deleted: false })
    expect(await required(curveTemplates.delete)({ name: 'Heatwave' })).toEqual({ deleted: true })
  })

  it('releases days whose rows are edited one at a time, but not when only paused', async () => {
    const monday = (await required(schedules.getAll)({ side: 'left' })).temperature.filter(r => r.dayOfWeek === 'monday')
    await required(schedules.updateTemperatureSchedule)({ id: monday[0].id, enabled: false })
    expect((await curve('Cool weeknights')).days.left).toContain('monday')
    await required(schedules.updateTemperatureSchedule)({ id: monday[0].id, temperature: 71 })
    expect((await curve('Cool weeknights')).days.left).not.toContain('monday')

    await required(schedules.createTemperatureSchedule)({ side: 'left', dayOfWeek: 'tuesday', time: '23:45', temperature: 70 })
    expect((await curve('Cool weeknights')).days.left).not.toContain('tuesday')

    const right = await required(schedules.getAll)({ side: 'right' })
    await required(schedules.deletePowerSchedule)({ id: required(right.power.find(p => p.dayOfWeek === 'friday')).id })
    expect((await curve('Warm weekends')).days.right).toEqual(['saturday'])

    const saturday = right.temperature.filter(r => r.dayOfWeek === 'saturday').map(r => r.id)
    await required(schedules.batchUpdate)({ deletes: { temperature: saturday } })
    expect(await curve('Warm weekends')).toMatchObject({ active: false, days: { left: [], right: [] } })
  })
})
