import { describe, expect, it } from 'vitest'
import { predictThermalModel, trainThermalModel } from '../thermal-model'
import type { ThermalNight } from '../thermal-learning'

const metadata = { side: 'left' as const, createdAt: Date.parse('2026-11-01T12:00:00Z'), datasetHash: 'a'.repeat(64), configuration: 'b'.repeat(64) }
const examples = (count = 24): ThermalNight[] => Array.from({ length: count }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, '0')}`, targetF: 70, waterF: 71, humidity: 45,
  roomF: index % 2 === 0 ? 68 : 76, correction: index % 2 === 0 ? 1 : -1,
}))
const context = ({ targetF, waterF, roomF, humidity }: ThermalNight) => ({ targetF, waterF, roomF, humidity })

describe('on-Pod comfort ridge model', () => {
  it('fits a contextual relationship and compares unseen whole nights with both baselines', () => {
    const model = trainThermalModel(examples(), metadata)
    expect(model.trainingDates).toHaveLength(18)
    expect(model.validationDates).toHaveLength(6)
    expect(model.trainingDates.some(date => model.validationDates.includes(date))).toBe(false)
    expect(model.validation.passesFeedbackCheck).toBe(true)
    expect(model.validation.modelMae).toBeLessThan(model.validation.holdMae * 0.9)
    expect(model.validation.modelMae).toBeLessThan(model.validation.averageMae * 0.9)
    expect(predictThermalModel(model, context(examples()[1]))).toMatchObject({ offsetF: -1 })
    expect(predictThermalModel(model, context(examples()[0]))).toMatchObject({ offsetF: 1 })
    expect(model.mode).toBe('research_preview')
  })
  it('never lets held-out labels or features affect fitting or feature scaling', () => {
    const input = examples()
    const changed = input.map((night, index) => index < 18 ? night : { ...night, correction: 0 as const, roomF: 95 })
    const first = trainThermalModel(input, metadata), second = trainThermalModel(changed, metadata)
    expect(second.coefficients).toEqual(first.coefficients)
    expect(second.support).toEqual(first.support)
    expect(second.validation.passesFeedbackCheck).toBe(false)
    expect(second.validation.supportedNights).toBe(0)
  })
  it('abstains for missing and unfamiliar measurements and for models without a baseline improvement', () => {
    const model = trainThermalModel(examples(), metadata)
    expect(predictThermalModel(model, null).offsetF).toBeNull()
    expect(predictThermalModel(model, { ...context(examples()[0]), roomF: 95 }).offsetF).toBeNull()
    expect(predictThermalModel(model, { ...context(examples()[0]), waterF: NaN }).offsetF).toBeNull()
    const constant = trainThermalModel(examples().map(night => ({ ...night, correction: 0 })), metadata)
    expect(constant.validation.passesFeedbackCheck).toBe(false)
    expect(predictThermalModel(constant, context(examples()[0])).offsetF).toBeNull()
  })
  it('rejects duplicate nights, impossible dates and inadequate training sets', () => {
    expect(() => trainThermalModel(examples(19), metadata)).toThrow(/20 complete/)
    expect(() => trainThermalModel([...examples(), examples()[0]], metadata)).toThrow(/distinct/)
    expect(() => trainThermalModel(examples().map((night, index) => index === 0 ? { ...night, date: '2026-02-30' } : night), metadata)).toThrow(/valid/)
  })
})
