import { responseWindowSchema, type ResponseWindow } from './response-window'
import { FEATURE_COUNT, RESPONSE_MODEL_MINIMUM_NIGHTS, responseInstantSchema as instant, responseInputSchema, responseModelSchema, type ResponseInput, type ResponseModel } from './response-model-schema'
export { responseInputSchema, responseModelSchema, responseModelShape, RESPONSE_MODEL_MINIMUM_NIGHTS } from './response-model-schema'
export type { ResponseInput, ResponseModel } from './response-model-schema'

interface Night { date: string, windows: ResponseWindow[] }

/** Fixed physical scales are chosen before fitting, so later nights cannot change normalization. */
function features(input: ResponseInput): number[] {
  return [1, (input.requestedTargetF - input.waterBeforeF) / 5, input.requestedTargetF - input.previousTargetF,
    (input.roomF - input.waterBeforeF) / 10, input.waterChange5mF / 2, (input.humidity - 50) / 20]
}
function inputFrom(window: ResponseWindow): ResponseInput {
  return responseInputSchema.parse({ observedAt: window.beforeAt, previousTargetF: window.previousTargetF,
    requestedTargetF: window.requestedTargetF, waterBeforeF: window.waterBeforeF, waterChange5mF: window.waterChange5mF,
    roomF: window.roomF, humidity: window.humidity })
}
const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
const percentile90 = (values: number[]) => [...values].sort((first, second) => first - second)[Math.ceil(values.length * 0.9) - 1]
const predict = (coefficients: number[], input: ResponseInput) => features(input).reduce((total, value, index) => total + value * coefficients[index], 0)
const outcome = (window: ResponseWindow, minutes: 15 | 30) => window.outcomes[minutes === 15 ? 0 : 1].changeF

/** Every night contributes equal weight; many small changes cannot impersonate many nights. */
function fit(nights: Night[], minutes: 15 | 30): number[] {
  const matrix = Array.from({ length: FEATURE_COUNT }, () => Array<number>(FEATURE_COUNT + 1).fill(0))
  for (const night of nights) for (const window of night.windows) {
    const values = features(inputFrom(window)), weight = 1 / night.windows.length
    for (let row = 0; row < FEATURE_COUNT; row++) {
      for (let column = 0; column < FEATURE_COUNT; column++) matrix[row][column] += weight * values[row] * values[column]
      matrix[row][FEATURE_COUNT] += weight * values[row] * outcome(window, minutes)
    }
  }
  for (let index = 1; index < FEATURE_COUNT; index++) matrix[index][index] += 0.1
  // Partial pivoting keeps correlated environmental features from producing unstable division.
  for (let column = 0; column < FEATURE_COUNT; column++) {
    let pivot = column
    for (let row = column + 1; row < FEATURE_COUNT; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
    ;[matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]]
    const divisor = matrix[column][column]
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-10) throw new Error('Response fitting matrix is singular.')
    for (let entry = column; entry <= FEATURE_COUNT; entry++) matrix[column][entry] /= divisor
    for (let row = 0; row < FEATURE_COUNT; row++) {
      if (row === column) continue
      const factor = matrix[row][column]
      for (let entry = column; entry <= FEATURE_COUNT; entry++) matrix[row][entry] -= factor * matrix[column][entry]
    }
  }
  return matrix.map(row => row[FEATURE_COUNT])
}

function supported(support: ResponseModel['support'], input: ResponseInput): boolean {
  const values = features(input), step = input.requestedTargetF - input.previousTargetF
  return new Set(support.filter(sample => sample.step === step && Math.abs(sample.previousTargetF - input.previousTargetF) <= 0.25
    && Math.hypot(...sample.values.slice(1).map((value, index) => value - values[index + 1])) <= 1.5)
    .map(sample => sample.date)).size >= 3
}

/** Revalidate timestamps and outcomes even when a caller already used the response audit. */
function grouped(input: ResponseWindow[], createdAt: number): Night[] {
  instant.parse(createdAt)
  if (input.length < 20 || input.length > 5760) throw new Error('Response fitting requires bounded, complete reviewed nights.')
  const groups = new Map<string, ResponseWindow[]>(), attempts = new Set<string>()
  for (const raw of input) {
    const window = responseWindowSchema.parse(raw)
    inputFrom(window)
    if (attempts.has(window.attemptId) || window.beforeAt >= window.at || window.at - window.beforeAt > 90_000
      || window.contextAt >= window.at || window.at - window.contextAt > 330_000
      || window.acknowledgedAt < window.at || window.acknowledgedAt - window.at > 30_000
      || window.confirmationAt < window.acknowledgedAt || window.confirmationAt - window.acknowledgedAt > 90_000
      || window.outcomes.some((result, index) => result.minutes !== (index === 0 ? 15 : 30)
        || Math.abs(result.at - window.at - result.minutes * 60_000) > 45_000 || result.at >= createdAt
        || Math.abs(result.changeF - (result.waterF - window.waterBeforeF)) > 1e-6)) {
      throw new Error('Response input has duplicate, inconsistent or future evidence.')
    }
    attempts.add(window.attemptId)
    groups.set(window.date, [...groups.get(window.date) ?? [], window])
  }
  const nights = [...groups].map(([nightDate, windows]) => ({ date: nightDate, windows: windows.sort((first, second) => first.at - second.at) }))
    .sort((first, second) => first.date.localeCompare(second.date))
  if (nights.length < RESPONSE_MODEL_MINIMUM_NIGHTS || nights.length > 90 || nights.some(night => night.windows.length > 64)) {
    throw new Error('Twenty distinct reviewed nights and at most 64 changes per night are required.')
  }
  for (const [index, night] of nights.entries()) {
    const previous = index > 0 ? nights[index - 1].windows : []
    if (night.windows.some((window, position) => position > 0 && window.at <= night.windows[position - 1].outcomes[1].at)
      || (previous.length > 0 && night.windows[0].beforeAt <= previous[previous.length - 1].outcomes[1].at)) {
      throw new Error('Response windows and whole-night splits must not overlap in time.')
    }
  }
  return nights
}

/** Fit, calibrate and evaluate on separate chronological nights; never refit on the final test nights. */
export function trainResponseModel(windows: ResponseWindow[], metadata: Pick<ResponseModel, 'side' | 'createdAt' | 'datasetHash' | 'configuration'>): ResponseModel {
  const nights = grouped(windows, metadata.createdAt)
  // Keep at least ten fitting nights as the cohort grows from twenty to twenty-one.
  const heldOut = Math.max(5, Math.min(Math.ceil(nights.length / 4), Math.floor((nights.length - 10) / 2)))
  const training = nights.slice(0, -2 * heldOut), calibration = nights.slice(-2 * heldOut, -heldOut), validation = nights.slice(-heldOut)
  const support: ResponseModel['support'] = training.flatMap(night => night.windows.map(window => ({ date: night.date,
    previousTargetF: window.previousTargetF, step: (window.requestedTargetF - window.previousTargetF) as -1 | 1, values: features(inputFrom(window)) })))
  const horizons = ([15, 30] as const).map((minutes) => {
    const coefficients = fit(training, minutes)
    let numerator = 0, denominator = 0
    for (const night of training) for (const window of night.windows) {
      const difference = window.requestedTargetF - window.waterBeforeF
      numerator += difference * outcome(window, minutes) / night.windows.length
      denominator += difference ** 2 / night.windows.length
    }
    const simpleCoefficient = Math.min(1, Math.max(0, denominator > 1e-10 ? numerator / denominator : 0))
    const residual = (window: ResponseWindow) => Math.abs(predict(coefficients, inputFrom(window)) - outcome(window, minutes))
    const errorBandF = Math.max(0.25, percentile90(calibration.map(night => percentile90(night.windows.map(residual)))))
    const metric = (score: (window: ResponseWindow) => number) => mean(validation.map(night => mean(night.windows.map(score))))
    const modelMaeF = metric(residual), persistenceMaeF = metric(window => Math.abs(outcome(window, minutes)))
    const simpleMaeF = metric(window => Math.abs(simpleCoefficient * (window.requestedTargetF - window.waterBeforeF) - outcome(window, minutes)))
    const trendMaeF = metric(window => Math.abs(window.waterChange5mF * minutes / 5 - outcome(window, minutes)))
    const intervalCoverage = metric(window => Number(residual(window) <= errorBandF))
    const supportedFraction = metric(window => Number(supported(support, inputFrom(window))))
    const baseline = Math.min(persistenceMaeF, simpleMaeF, trendMaeF)
    const passes = supportedFraction >= 0.9 && intervalCoverage >= 0.8 && modelMaeF <= baseline * 0.9 && baseline - modelMaeF >= 0.1
    return { minutes, coefficients, simpleCoefficient, errorBandF,
      validation: { modelMaeF, persistenceMaeF, simpleMaeF, trendMaeF, intervalCoverage, supportedFraction, passes } }
  })
  const lastNight = nights[nights.length - 1]
  return responseModelSchema.parse({ ...metadata, version: 'target-response-ridge-v1', purpose: 'observed-water-response',
    mode: 'research_preview', attribution: 'physical_zone_only', sourceLastAt: lastNight.windows[lastNight.windows.length - 1].outcomes[1].at,
    trainingDates: training.map(night => night.date), calibrationDates: calibration.map(night => night.date),
    validationDates: validation.map(night => night.date), support, horizons })
}

/** This is conditional water-response research, not a causal estimate or an actuator request. */
export function predictResponseModel(model: ResponseModel, input: ResponseInput | null, now: number) {
  const artifact = responseModelSchema.safeParse(model), current = responseInputSchema.safeParse(input)
  const withheld = (reason: string) => ({ predictions: [], reason })
  if (!instant.safeParse(now).success || !artifact.success || artifact.data.createdAt > now
    || now - artifact.data.sourceLastAt > 30 * 86_400_000 || artifact.data.horizons.some(horizon => !horizon.validation.passes)) {
    return withheld('Both response horizons must pass later-night comparisons with a recent, valid artifact.')
  }
  if (!current.success || current.data.observedAt > now || now - current.data.observedAt > 90_000
    || !supported(artifact.data.support, current.data)) return withheld('Fresh conditions and this target direction must match at least three training nights.')
  const predictions = artifact.data.horizons.map((horizon) => {
    const waterF = current.data.waterBeforeF + predict(horizon.coefficients, current.data)
    return { minutes: horizon.minutes, waterF, lowerF: waterF - horizon.errorBandF, upperF: waterF + horizon.errorBandF }
  })
  if (predictions.some(value => !Number.isFinite(value.waterF) || value.lowerF < 50 || value.upperF > 115)) return withheld('The response leaves the supported water-temperature range.')
  return { predictions, reason: 'Observed water response under similar recorded conditions. Empirical error bands are not causal or medical confidence intervals. No target change was requested.' }
}
