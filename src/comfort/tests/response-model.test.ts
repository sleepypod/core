import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { predictResponseModel, responseModelSchema, trainResponseModel, type ResponseInput } from '../response-model'
import type { ResponseWindow } from '../response-window'
import { responseModelWindows as fixture } from './responseModelFixture'

const start = Date.UTC(2026, 9, 1, 22), now = start + 21 * 86_400_000
const metadata = { side: 'left' as const, createdAt: now, datasetHash: 'a'.repeat(64), configuration: 'b'.repeat(64) }

function current(window: ResponseWindow): ResponseInput {
  return { observedAt: now, previousTargetF: window.previousTargetF, requestedTargetF: window.requestedTargetF,
    waterBeforeF: window.waterBeforeF, waterChange5mF: window.waterChange5mF, roomF: window.roomF, humidity: window.humidity }
}
function shiftOutcome(window: ResponseWindow, amount: number) {
  for (const result of window.outcomes) {
    result.changeF += amount
    result.waterF += amount
  }
}

describe('small-target response model', () => {
  it.each([20, 21, 22, 25, 90])('keeps ten training nights when a cohort grows to %s nights', (count) => {
    const template = fixture().slice(0, 4)
    const windows = Array.from({ length: count }, (_, night) => template.map((source) => {
      const window = structuredClone(source), offset = night * 86_400_000
      window.attemptId = randomUUID()
      window.date = new Date(Date.parse(window.date) + offset).toISOString().slice(0, 10)
      for (const key of ['at', 'beforeAt', 'contextAt', 'acknowledgedAt', 'confirmationAt'] as const) window[key] += offset
      for (const result of window.outcomes) result.at += offset
      return window
    })).flat()
    const model = trainResponseModel(windows, { ...metadata, createdAt: start + (count + 1) * 86_400_000 })
    expect(model.trainingDates.length).toBeGreaterThanOrEqual(10)
    expect(model.calibrationDates.length).toBeGreaterThanOrEqual(5)
    expect(model.validationDates.length).toBeGreaterThanOrEqual(5)
    expect(model.trainingDates.length + model.calibrationDates.length + model.validationDates.length).toBe(count)
  })

  it('holds out whole chronological nights and beats three simple baselines on a learnable fixture', () => {
    const model = trainResponseModel(fixture(), metadata)
    expect(model.trainingDates).toHaveLength(10)
    expect(model.calibrationDates).toHaveLength(5)
    expect(model.validationDates).toHaveLength(5)
    expect(new Set([...model.trainingDates, ...model.calibrationDates, ...model.validationDates]).size).toBe(20)
    expect(model.support.every(sample => model.trainingDates.includes(sample.date))).toBe(true)
    for (const horizon of model.horizons) {
      expect(horizon.validation.passes, JSON.stringify(horizon.validation)).toBe(true)
      expect(horizon.validation.modelMaeF).toBeLessThan(0.25)
      expect(horizon.validation.intervalCoverage).toBeGreaterThanOrEqual(0.8)
    }
    expect(model.mode).toBe('research_preview')
    expect(model.attribution).toBe('physical_zone_only')
  })

  it('does not use final test outcomes for fitting, support or calibration', () => {
    const data = fixture(), original = trainResponseModel(data, metadata)
    for (const window of data.slice(60)) shiftOutcome(window, 5)
    const changed = trainResponseModel(data, metadata)
    expect(changed.support).toEqual(original.support)
    for (const [index, horizon] of changed.horizons.entries()) {
      expect(horizon.coefficients).toEqual(original.horizons[index].coefficients)
      expect(horizon.errorBandF).toBe(original.horizons[index].errorBandF)
      expect(horizon.simpleCoefficient).toBe(original.horizons[index].simpleCoefficient)
      expect(horizon.validation.passes).toBe(false)
    }
  })

  it('uses calibration outcomes only for the empirical band', () => {
    const data = fixture(), original = trainResponseModel(data, metadata)
    for (const window of data.slice(40, 60)) shiftOutcome(window, 2)
    const changed = trainResponseModel(data, metadata)
    expect(changed.horizons[0].coefficients).toEqual(original.horizons[0].coefficients)
    expect(changed.horizons[0].errorBandF).toBeGreaterThan(1)
    expect(changed.horizons[0].validation.modelMaeF).toBe(original.horizons[0].validation.modelMaeF)
  })

  it('does not approve a model when persistence already explains the outcomes', () => {
    const data = fixture()
    for (const window of data) for (const result of window.outcomes) {
      result.waterF = window.waterBeforeF
      result.changeF = 0
    }
    const model = trainResponseModel(data, metadata)
    expect(model.horizons.every(horizon => !horizon.validation.passes)).toBe(true)
    expect(predictResponseModel(model, current(data[0]), now).predictions).toEqual([])
  })

  it('keeps a small apparent improvement below the fixed acceptance threshold withheld', () => {
    const model = trainResponseModel(fixture(0.35), metadata)
    const score = model.horizons[0].validation
    expect(score.modelMaeF).toBeLessThan(score.simpleMaeF)
    expect(score.simpleMaeF - score.modelMaeF).toBeLessThan(0.1)
    expect(score.passes).toBe(false)
  })

  it.each([
    ['nineteen nights', (data: ResponseWindow[]) => data.splice(76)],
    ['duplicate receipt', (data: ResponseWindow[]) => { data[1].attemptId = data[0].attemptId }],
    ['duplicate overlapping observations', (data: ResponseWindow[]) => data.push({ ...data[0], attemptId: randomUUID() })],
    ['many windows from one night', (data: ResponseWindow[]) => { for (const window of data) window.date = data[0].date }],
    ['future feature', (data: ResponseWindow[]) => { data[0].contextAt = data[0].at + 1 }],
    ['stale preceding water', (data: ResponseWindow[]) => { data[0].beforeAt = data[0].at - 90_001 }],
    ['late acknowledgment', (data: ResponseWindow[]) => { data[0].acknowledgedAt = data[0].at + 30_001 }],
    ['unconfirmed target', (data: ResponseWindow[]) => { data[0].confirmationAt = data[0].acknowledgedAt - 1 }],
    ['wrong target step', (data: ResponseWindow[]) => { data[0].requestedTargetF += 5 }],
    ['inconsistent outcome', (data: ResponseWindow[]) => { data[0].outcomes[0].changeF += 1 }],
    ['duplicated horizon', (data: ResponseWindow[]) => { data[0].outcomes[1].minutes = 15 }],
    ['late outcome', (data: ResponseWindow[]) => { data[0].outcomes[1].at += 45_001 }],
    ['reversed night chronology', (data: ResponseWindow[]) => {
      const first = data[0].date
      for (const window of data.slice(0, 4)) window.date = data[4].date
      for (const window of data.slice(4, 8)) window.date = first
    }],
  ])('rejects %s rather than manufacturing training data', (_label, mutate) => {
    const data = fixture()
    mutate(data)
    expect(() => trainResponseModel(data, metadata)).toThrow()
  })

  it('rejects unfinished nights and invalid fit clocks', () => {
    expect(() => trainResponseModel(fixture(), { ...metadata, createdAt: start })).toThrow()
    expect(() => trainResponseModel(fixture(), { ...metadata, createdAt: NaN })).toThrow()
  })

  it('predicts only the two observed water horizons, with no actuator fields', () => {
    const data = fixture(), model = trainResponseModel(data, metadata)
    const result = predictResponseModel(model, current(data[0]), now)
    expect(result.predictions.map(item => item.minutes)).toEqual([15, 30])
    expect(result.predictions.every(item => item.lowerF < item.waterF && item.upperF > item.waterF)).toBe(true)
    expect(Object.keys(result)).toEqual(['predictions', 'reason'])
    expect(result.reason).toContain('No target change was requested')
  })

  it('withdraws stale, future, unsupported and malformed current inputs', () => {
    const data = fixture(), model = trainResponseModel(data, metadata), input = current(data[0])
    for (const invalid of [null, { ...input, observedAt: now - 90_001 }, { ...input, observedAt: now + 1 },
      { ...input, previousTargetF: 85, requestedTargetF: 84 }, { ...input, roomF: 95 }, { ...input, requestedTargetF: 60 }]) {
      expect(predictResponseModel(model, invalid, now).predictions).toEqual([])
    }
  })

  it('requires direction support from three distinct training nights', () => {
    const data = fixture(), model = trainResponseModel(data, metadata), input = current(data[0])
    model.support = model.support.filter(sample => sample.step === 1 || model.trainingDates.slice(0, 2).includes(sample.date))
    expect(responseModelSchema.safeParse(model).success).toBe(true)
    expect(predictResponseModel(model, input, now).predictions).toEqual([])
  })

  it('rejects invalid artifact clocks, split leaks and horizon identity', () => {
    const data = fixture(), model = trainResponseModel(data, metadata), input = current(data[0])
    expect(predictResponseModel(model, input, now - 1).predictions).toEqual([])
    expect(predictResponseModel(model, { ...input, observedAt: now + 31 * 86_400_000 }, now + 31 * 86_400_000).predictions).toEqual([])
    const leaked = structuredClone(model)
    leaked.support[0].date = model.validationDates[0]
    expect(predictResponseModel(leaked, input, now).predictions).toEqual([])
    const swapped = structuredClone(model)
    swapped.horizons.reverse()
    expect(predictResponseModel(swapped, input, now).predictions).toEqual([])
  })
})
