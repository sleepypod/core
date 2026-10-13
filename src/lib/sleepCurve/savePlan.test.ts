import { describe, expect, it } from 'vitest'
import { planCurveSave } from './savePlan'

const existing = {
  temperature: [{ id: 1, dayOfWeek: 'monday' }, { id: 2, dayOfWeek: 'tuesday' }, { id: 3, dayOfWeek: 'wednesday' }],
  power: [{ id: 10, dayOfWeek: 'monday' }, { id: 11, dayOfWeek: 'wednesday' }],
}

describe('planCurveSave', () => {
  it('replaces the target and cleared days and derives an overnight on/off window', () => {
    const plan = planCurveSave({
      sides: ['left', 'right'],
      targetDays: ['monday'],
      clearDays: ['tuesday'],
      setPoints: [{ time: '06:30', temperature: 80 }, { time: '22:00', temperature: 72 }, { time: '01:00', temperature: 68.4 }],
      existing,
    })
    expect(plan.deletes).toEqual({ temperature: [1, 2], power: [10] })
    expect(plan.setPoints.map(p => p.time)).toEqual(['22:00', '01:00', '06:30'])
    expect(plan.power).toEqual({ onTime: '22:00', offTime: '06:30', onTemperature: 72, endAction: 'turn_off' })
    expect(plan.creates.temperature).toHaveLength(6)
    expect(plan.creates.temperature[1]).toEqual({ side: 'left', dayOfWeek: 'monday', time: '01:00', temperature: 68, enabled: true })
    expect(plan.creates.power.map(p => p.side)).toEqual(['left', 'right'])
  })

  it('drops flat-hold rows and clamps the power temperature', () => {
    const plan = planCurveSave({
      sides: ['left'],
      targetDays: ['monday'],
      setPoints: [{ time: '20:00', temperature: 120 }, { time: '21:00', temperature: 70 }, { time: '22:00', temperature: 70 }, { time: '23:00', temperature: 70 }],
      existing: { temperature: [], power: [] },
    })
    expect(plan.setPoints.map(p => p.time)).toEqual(['20:00', '21:00', '23:00'])
    expect(plan.power?.onTemperature).toBe(110)
  })

  it('skips the power window for a single turn_off point but keeps it for maintain', () => {
    const base = { sides: ['left' as const], targetDays: ['monday' as const], setPoints: [{ time: '22:00', temperature: 70 }], existing: { temperature: [], power: [] } }
    expect(planCurveSave(base).power).toBeNull()
    expect(planCurveSave(base).creates.power).toEqual([])
    expect(planCurveSave({ ...base, endAction: 'maintain' }).power).toEqual({ onTime: '22:00', offTime: '22:00', onTemperature: 70, endAction: 'maintain' })
  })
})
