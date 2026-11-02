import { z } from 'zod'
import { thermalContextSchema } from './thermal-learning'
import type { ThermalRecording } from './thermal-dataset'

export const FORECAST_MINIMUM_NIGHTS = 20
const FEATURES = 5
const finite = z.number().finite()
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const vector = z.array(finite).length(FEATURES)
export const forecastInputSchema = thermalContextSchema.extend({ change5mF: finite.min(-10).max(10) }).strict()
export type ForecastInput = z.infer<typeof forecastInputSchema>
export interface ForecastExample { at: number, input: ForecastInput, changeF: number }
export interface ForecastNight { date: string, examples: ForecastExample[] }

const horizonSchema = z.object({
  minutes: z.union([z.literal(15), z.literal(30)]), coefficients: vector,
  simpleCoefficient: finite.min(0).max(1), errorBandF: finite.nonnegative(),
  validation: z.object({
    modelMaeF: finite.nonnegative(), persistenceMaeF: finite.nonnegative(), simpleMaeF: finite.nonnegative(),
    intervalCoverage: finite.min(0).max(1), supportedFraction: finite.min(0).max(1),
    passes: z.boolean(), reason: z.string(),
  }).strict(),
}).strict()
export const thermalForecastShape = z.object({
  version: z.literal('water-response-ridge-v1'), purpose: z.literal('water-temperature-forecast'),
  mode: z.literal('research_preview'), side: z.enum(['left', 'right']), createdAt: z.number().int().positive(),
  sourceLastAt: z.number().int().positive(),
  datasetHash: hash, configuration: hash,
  trainingDates: z.array(date).min(10).max(46), calibrationDates: z.array(date).min(5).max(23),
  validationDates: z.array(date).min(5).max(23),
  support: z.array(z.object({ date, targetF: finite, values: vector }).strict()).min(10).max(4500),
  horizons: z.array(horizonSchema).length(2),
}).strict()
export const thermalForecastSchema = thermalForecastShape
  .refine(model => model.horizons[0].minutes === 15 && model.horizons[1].minutes === 30, 'Both distinct horizons must be present in order.')
  .refine(model => model.sourceLastAt < model.createdAt, 'Reference recordings must precede fitting.')
  .refine((model) => {
    const dates = [...model.trainingDates, ...model.calibrationDates, ...model.validationDates]
    return new Set(dates).size === dates.length && dates.every((value, index) => index === 0 || value > dates[index - 1])
      && model.support.every(sample => model.trainingDates.includes(sample.date))
  }, 'Whole-night splits must be disjoint, chronological and contain all support references.')
export type ThermalForecast = z.infer<typeof thermalForecastSchema>
export const thermalForecastPredictionSchema = z.object({
  predictions: z.array(z.object({ minutes: finite, waterF: finite, lowerF: finite, upperF: finite }).strict()),
  reason: z.string(),
}).strict()

/** Only preceding measurements are features; future measurements supply labels under a held target. */
export function forecastExamples(recording: ThermalRecording, minutes: 15 | 30): ForecastNight {
  const samples = recording.samples
  if (!date.safeParse(recording.date).success || !Number.isFinite(Date.parse(recording.date))
    || new Date(recording.date).toISOString().slice(0, 10) !== recording.date
    || samples.length < 72 || samples.length > 300) throw new Error('Forecast fitting requires complete reviewed nights.')
  for (const [index, sample] of samples.entries()) {
    thermalContextSchema.parse(sample.context)
    if (!Number.isSafeInteger(sample.at) || sample.at <= 0 || (index > 0
      && (sample.at <= samples[index - 1].at || sample.at - samples[index - 1].at > 600_000))) {
      throw new Error('Forecast recording has invalid timestamps or a large gap.')
    }
  }
  const duration = samples[samples.length - 1].at - samples[0].at
  if (duration < 6 * 3_600_000 || duration > 12 * 3_600_000) throw new Error('Forecast recording is not a complete six-to-twelve-hour night.')
  const examples: ForecastExample[] = []
  let lastAnchor = 0
  for (let index = 1; index < samples.length; index++) {
    const current = samples[index], previous = samples[index - 1]
    if (current.at - lastAnchor < 900_000 || Math.abs(current.at - previous.at - 300_000) > 30_000
      || current.context.targetF !== previous.context.targetF) continue
    const futureIndex = samples.findIndex((sample, candidate) => candidate > index
      && Math.abs(sample.at - current.at - minutes * 60_000) <= 45_000)
    if (futureIndex < 0) continue
    const following = samples.slice(index, futureIndex + 1)
    if (following.some((sample, step) => sample.context.targetF !== current.context.targetF
      || Math.abs(sample.context.roomF - current.context.roomF) > 2
      || Math.abs(sample.context.humidity - current.context.humidity) > 10
      || (step > 0 && Math.abs(sample.at - following[step - 1].at - 300_000) > 30_000))) continue
    const parsed = forecastInputSchema.safeParse({ ...current.context,
      change5mF: (current.context.waterF - previous.context.waterF) * 300_000 / (current.at - previous.at) })
    if (!parsed.success) continue
    examples.push({ at: current.at, input: parsed.data, changeF: samples[futureIndex].context.waterF - current.context.waterF })
    lastAnchor = current.at
  }
  return { date: recording.date, examples }
}

/** Fixed physical scales avoid fitting normalization to later calibration or test nights. */
function features(input: ForecastInput): number[] {
  return [1, (input.targetF - input.waterF) / 5, (input.roomF - input.waterF) / 10,
    input.change5mF / 2, (input.humidity - 50) / 20]
}
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
const predict = (coefficients: number[], input: ForecastInput) => features(input).reduce((total, value, index) => total + value * coefficients[index], 0)
const percentile90 = (values: number[]) => [...values].sort((first, second) => first - second)[Math.ceil(values.length * 0.9) - 1]

/** Each night has equal total weight, regardless of its number of forecast origins. */
function fit(nights: ForecastNight[]): number[] {
  const matrix = Array.from({ length: FEATURES }, () => Array<number>(FEATURES + 1).fill(0))
  for (const night of nights) {
    for (const example of night.examples) {
      const values = features(example.input), weight = 1 / night.examples.length
      for (let row = 0; row < FEATURES; row++) {
        for (let column = 0; column < FEATURES; column++) matrix[row][column] += weight * values[row] * values[column]
        matrix[row][FEATURES] += weight * values[row] * example.changeF
      }
    }
  }
  for (let index = 1; index < FEATURES; index++) matrix[index][index] += 0.01
  for (let column = 0; column < FEATURES; column++) {
    let pivot = column
    for (let row = column + 1; row < FEATURES; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
    ;[matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]]
    const divisor = matrix[column][column]
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-10) throw new Error('Forecast fitting matrix is singular.')
    for (let entry = column; entry <= FEATURES; entry++) matrix[column][entry] /= divisor
    for (let row = 0; row < FEATURES; row++) {
      if (row === column) continue
      const factor = matrix[row][column]
      for (let entry = column; entry <= FEATURES; entry++) matrix[row][entry] -= factor * matrix[column][entry]
    }
  }
  return matrix.map(row => row[FEATURES])
}

function supportMatches(support: ThermalForecast['support'], input: ForecastInput): boolean {
  const current = features(input)
  return new Set(support.filter(sample => Math.abs(sample.targetF - input.targetF) <= 0.25
    && Math.hypot(...sample.values.slice(1).map((value, index) => value - current[index + 1])) <= 1.5)
    .map(sample => sample.date)).size >= 3
}

/** Calibration nights set the band; final test nights never influence coefficients, support or bands. */
export function trainThermalForecast(recordings: ThermalRecording[], metadata: Pick<ThermalForecast, 'side' | 'createdAt' | 'datasetHash' | 'configuration'>): ThermalForecast {
  if (recordings.length < FORECAST_MINIMUM_NIGHTS || recordings.length > 90
    || new Set(recordings.map(recording => recording.date)).size !== recordings.length) throw new Error('Twenty distinct complete reviewed nights are required.')
  const ordered = [...recordings].sort((first, second) => first.date.localeCompare(second.date))
  for (const [index, night] of ordered.entries()) {
    forecastExamples(night, 30)
    const previousEnd = index > 0 ? ordered[index - 1].samples.at(-1)?.at : undefined
    if (previousEnd !== undefined && night.samples[0].at <= previousEnd) throw new Error('Distinct nights must not overlap in time.')
  }
  if (ordered.some(night => night.samples.some(sample => sample.at >= metadata.createdAt))) throw new Error('A recording is unfinished or in the future.')
  const heldOut = Math.max(5, Math.ceil(ordered.length / 4))
  const training = ordered.slice(0, -2 * heldOut), calibration = ordered.slice(-2 * heldOut, -heldOut), validation = ordered.slice(-heldOut)
  const support = training.flatMap(recording => forecastExamples(recording, 30).examples
    .map(example => ({ date: recording.date, targetF: example.input.targetF, values: features(example.input) })))
  const horizons = ([15, 30] as const).map((minutes) => {
    const groups = [training, calibration, validation].map(group => group.map(recording => forecastExamples(recording, minutes)))
    if (groups.some(group => group.some(night => night.examples.length < 12))) throw new Error('Every night needs at least twelve stable, preceding-only forecast examples for each horizon.')
    const [fitNights, calibrationNights, testNights] = groups
    const coefficients = fit(fitNights)
    let numerator = 0, denominator = 0
    for (const night of fitNights) for (const example of night.examples) {
      const difference = example.input.targetF - example.input.waterF
      numerator += difference * example.changeF / night.examples.length
      denominator += difference ** 2 / night.examples.length
    }
    const simpleCoefficient = Math.min(1, Math.max(0, denominator > 1e-10 ? numerator / denominator : 0))
    const errorBandF = Math.max(0.25, percentile90(calibrationNights.map(night => percentile90(night.examples.map(example => Math.abs(predict(coefficients, example.input) - example.changeF))))))
    const metric = (score: (example: ForecastExample) => number) => mean(testNights.map(night => mean(night.examples.map(score))))
    const modelMaeF = metric(example => Math.abs(predict(coefficients, example.input) - example.changeF))
    const persistenceMaeF = metric(example => Math.abs(example.changeF))
    const simpleMaeF = metric(example => Math.abs(simpleCoefficient * (example.input.targetF - example.input.waterF) - example.changeF))
    const intervalCoverage = metric(example => Number(Math.abs(predict(coefficients, example.input) - example.changeF) <= errorBandF))
    const supportedFraction = metric(example => Number(supportMatches(support, example.input)))
    const baseline = Math.min(persistenceMaeF, simpleMaeF)
    const passes = supportedFraction >= 0.9 && intervalCoverage >= 0.8 && modelMaeF <= baseline * 0.9 && baseline - modelMaeF >= 0.1
    return { minutes, coefficients, simpleCoefficient, errorBandF,
      validation: { modelMaeF, persistenceMaeF, simpleMaeF, intervalCoverage, supportedFraction, passes,
        reason: passes
          ? 'Water forecasts improved on both baselines in later test nights. This does not establish comfort or safe control.'
          : 'Forecast accuracy, coverage or supported conditions did not meet the comparison gates. Keep the routine.' } }
  })
  return thermalForecastSchema.parse({ ...metadata, version: 'water-response-ridge-v1', purpose: 'water-temperature-forecast', mode: 'research_preview',
    sourceLastAt: ordered[ordered.length - 1].samples.at(-1)?.at,
    trainingDates: training.map(night => night.date), calibrationDates: calibration.map(night => night.date), validationDates: validation.map(night => night.date), support, horizons })
}

/** A forecast describes water under an unchanged target; it is never an actuator request or body temperature. */
export function predictThermalForecast(model: ThermalForecast, input: ForecastInput | null) {
  const parsed = thermalForecastSchema.safeParse(model), current = forecastInputSchema.safeParse(input)
  if (!parsed.success || parsed.data.horizons.some(horizon => !horizon.validation.passes)) return { predictions: [], reason: 'Both forecast horizons must pass independent whole-night comparisons.' }
  if (!current.success || !supportMatches(parsed.data.support, current.data)) return { predictions: [], reason: 'Fresh conditions must match at least three training nights, including the current target.' }
  const predictions = parsed.data.horizons.map((horizon) => {
    const waterF = current.data.waterF + predict(horizon.coefficients, current.data)
    return { minutes: horizon.minutes, waterF, lowerF: waterF - horizon.errorBandF, upperF: waterF + horizon.errorBandF }
  })
  if (predictions.some(value => !Number.isFinite(value.waterF) || value.lowerF < 50 || value.upperF > 115)) return { predictions: [], reason: 'The forecast leaves the supported water-temperature range.' }
  return { predictions, reason: 'Assumes the target stays unchanged and room conditions remain similar. Bands are empirical forecast errors, not medical confidence intervals. No adjustment was made.' }
}
