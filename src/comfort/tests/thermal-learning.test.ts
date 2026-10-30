import { describe, expect, it } from 'vitest'
import { evaluateThermalLearning, type ThermalNight } from '../thermal-learning'

const today = '2026-10-29'
const context = { targetF: 70, waterF: 70, roomF: 78, humidity: 50 }
const examples = (count = 24): ThermalNight[] => Array.from({ length: count }, (_, index) => ({
  ...context, date: `2026-10-${String(index + 1).padStart(2, '0')}`,
  roomF: index % 2 ? 78 : 65, correction: index % 2 ? -1 : 1,
}))

describe('contextual comfort research model', () => {
  it('requires distinct nights, not hundreds of within-night sensor points', () => {
    expect(evaluateThermalLearning(examples(19), context, today)).toMatchObject({ nights: 19, suggestedOffsetF: null, validationNights: 0 })
    expect(evaluateThermalLearning(Array(700).fill(examples(1)[0]), context, today).nights).toBe(0)
  })
  it('holds out later nights and predicts a bounded cooling suggestion for a known warm context', () => {
    expect(evaluateThermalLearning(examples(), context, today)).toMatchObject({
      mode: 'research_preview', nights: 24, trainingNights: 18, validationNights: 6,
      modelErrorF: 0, baselineErrorF: 1, suggestedOffsetF: -1,
    })
  })
  it('does not use validation labels as training data', () => {
    const changed = examples().map((night, index) => index >= 18 ? { ...night, correction: -night.correction as -1 | 1 } : night)
    expect(evaluateThermalLearning(changed, context, today)).toMatchObject({ modelErrorF: 2, suggestedOffsetF: null })
  })
  it('keeps the simpler baseline when all labels say warm', () => {
    const nights = examples().map(night => ({ ...night, correction: -1 as const }))
    expect(evaluateThermalLearning(nights, context, today)).toMatchObject({ baselineErrorF: 0, suggestedOffsetF: null })
  })
  it('withholds for absent, invalid or out-of-distribution current inputs', () => {
    for (const current of [null, { ...context, roomF: 99 }, { ...context, waterF: NaN }]) {
      expect(evaluateThermalLearning(examples(), current, today).suggestedOffsetF).toBeNull()
    }
  })
  it('rejects future dates and malformed measurements instead of filling them', () => {
    const invalid = [
      { ...examples(1)[0], date: '2026-11-01' },
      { ...examples(1)[0], date: '2026-02-31' },
      { ...examples(1)[0], waterF: Infinity },
    ]
    expect(evaluateThermalLearning(invalid, context, today).nights).toBe(0)
  })
})
