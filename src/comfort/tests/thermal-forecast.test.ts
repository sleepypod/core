import { describe, expect, it } from 'vitest'
import { forecastExamples, predictThermalForecast, trainThermalForecast } from '../thermal-forecast'
import { forecastRecordings } from './forecastFixture'

const metadata = { side: 'left' as const, createdAt: Date.parse('2026-11-01'), datasetHash: 'a'.repeat(64), configuration: 'b'.repeat(64) }

describe('preceding-only water-response forecasts', () => {
  it('holds whole nights apart for fitting, calibration and final testing', () => {
    const recordings = forecastRecordings()
    const model = trainThermalForecast(recordings, metadata)
    expect(model.trainingDates).toHaveLength(12)
    expect(model.calibrationDates).toHaveLength(6)
    expect(model.validationDates).toHaveLength(6)
    expect(new Set([...model.trainingDates, ...model.calibrationDates, ...model.validationDates]).size).toBe(24)
    expect(model.horizons.map(horizon => horizon.minutes)).toEqual([15, 30])
    expect(model.horizons.every(horizon => horizon.validation.modelMaeF < horizon.validation.persistenceMaeF)).toBe(true)
    expect(model.horizons.every(horizon => horizon.validation.passes)).toBe(true)
    expect(predictThermalForecast(model, forecastExamples(recordings[22], 30).examples[3].input).predictions).toHaveLength(2)
  })
  it('later test-night changes cannot leak into coefficients, support or calibration bands', () => {
    const original = forecastRecordings(), modified = structuredClone(original)
    modified.slice(-6).forEach(night => night.samples.forEach((sample) => {
      sample.context.waterF += 4
    }))
    const before = trainThermalForecast(original, metadata), after = trainThermalForecast(modified, metadata)
    expect(after.support).toEqual(before.support)
    expect(after.horizons.map(horizon => [horizon.coefficients, horizon.errorBandF, horizon.simpleCoefficient]))
      .toEqual(before.horizons.map(horizon => [horizon.coefficients, horizon.errorBandF, horizon.simpleCoefficient]))
    expect(after.horizons.map(horizon => horizon.validation)).not.toEqual(before.horizons.map(horizon => horizon.validation))
  })
  it('future target changes remove a window instead of becoming an input feature', () => {
    const night = forecastRecordings()[0]
    const before = forecastExamples(night, 30)
    const current = before.examples[2]
    const changed = night.samples.find(sample => sample.at === current.at + 300_000)
    if (!changed) throw new Error('Fixture lacks the requested future sample')
    changed.context.targetF += 1
    const after = forecastExamples(night, 30)
    expect(after.examples.some(example => example.at === current.at)).toBe(false)
    expect(Object.keys(before.examples[0].input).sort()).toEqual(['change5mF', 'humidity', 'roomF', 'targetF', 'waterF'])
  })
  it('rejects fragments, duplicate nights, temporal overlap and future observations', () => {
    expect(() => trainThermalForecast(forecastRecordings(19), metadata)).toThrow(/Twenty/)
    const duplicate = forecastRecordings()
    duplicate[1].date = duplicate[0].date
    expect(() => trainThermalForecast(duplicate, metadata)).toThrow(/distinct/)
    const overlap = forecastRecordings()
    overlap[1].samples = structuredClone(overlap[0].samples)
    expect(() => trainThermalForecast(overlap, metadata)).toThrow(/overlap/)
    const fragment = forecastRecordings()[0]
    fragment.samples = fragment.samples.slice(0, 60)
    expect(() => forecastExamples(fragment, 15)).toThrow(/complete/)
    expect(() => trainThermalForecast(forecastRecordings(), { ...metadata, createdAt: Date.UTC(2026, 8, 3) })).toThrow(/future/)
  })
  it('rejects gaps and missing data without interpolation or padding', () => {
    const night = forecastRecordings()[0]
    night.samples.splice(30, 4)
    expect(() => forecastExamples(night, 30)).toThrow(/gap/)
    const malformed = forecastRecordings()[0]
    malformed.samples[15].context.waterF = Number.NaN
    expect(() => forecastExamples(malformed, 15)).toThrow()
  })
  it('abstains outside observed targets, without a predecessor, or after failed validation', () => {
    const recordings = forecastRecordings(), model = trainThermalForecast(recordings, metadata)
    const input = forecastExamples(recordings[20], 30).examples[4].input
    expect(predictThermalForecast(model, null).predictions).toEqual([])
    expect(predictThermalForecast(model, { ...input, targetF: 90 }).predictions).toEqual([])
    model.horizons[0].validation.passes = false
    expect(predictThermalForecast(model, input).predictions).toEqual([])
  })
  it('does not turn a constant water series into a claim of improved forecasting', () => {
    const recordings = forecastRecordings()
    recordings.forEach(night => night.samples.forEach((sample) => {
      sample.context.waterF = sample.context.targetF
    }))
    const model = trainThermalForecast(recordings, metadata)
    expect(model.horizons.every(horizon => horizon.validation.persistenceMaeF === 0 && !horizon.validation.passes)).toBe(true)
  })
  it('withholds both forecasts when one horizon improves by less than a tenth of a degree', () => {
    const recordings = forecastRecordings(24, 0.018), model = trainThermalForecast(recordings, metadata)
    expect(model.horizons[0].validation.passes).toBe(false)
    expect(model.horizons[1].validation.passes).toBe(true)
    expect(predictThermalForecast(model, forecastExamples(recordings[20], 30).examples[4].input).predictions).toEqual([])
  })
})
