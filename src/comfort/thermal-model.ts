import { createHash } from 'node:crypto'
import { z } from 'zod'
import { thermalContextSchema, type ThermalContext, type ThermalNight } from './thermal-learning'

export const THERMAL_MODEL_MINIMUM_NIGHTS = 20
const FEATURE_COUNT = 5
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const finite = z.number().finite()

export const thermalModelSchema = z.object({
  version: z.literal('comfort-ridge-v1'), purpose: z.literal('morning-comfort-direction'),
  mode: z.literal('research_preview'), side: z.enum(['left', 'right']),
  createdAt: z.number().int().positive(), datasetHash: hash, configuration: hash,
  trainingDates: z.array(date).min(15).max(90), validationDates: z.array(date).min(5).max(30),
  coefficients: z.array(finite).length(FEATURE_COUNT),
  support: z.array(thermalContextSchema).min(15).max(90),
  validation: z.object({
    modelMae: finite.nonnegative(), holdMae: finite.nonnegative(), averageMae: finite.nonnegative(),
    residual90: finite.nonnegative(), supportedNights: z.number().int().nonnegative(),
    passesFeedbackCheck: z.boolean(), reason: z.string(),
  }).strict(),
}).strict()
export type ThermalModel = z.infer<typeof thermalModelSchema>
export const thermalPredictionSchema = z.object({
  offsetF: z.number().min(-1).max(1).nullable(), rawDirection: finite.nullable(),
  reason: z.string(),
}).strict()

/** Fixed scales and regularization are chosen before evaluation; no held-out night affects fitting. */
function features(context: ThermalContext): number[] {
  return [1, (context.targetF - 72) / 3, (context.waterF - context.targetF) / 3,
    (context.roomF - 72) / 3, (context.humidity - 45) / 15]
}

/** A five-parameter ridge regression is small enough to fit and evaluate on the embedded Pod. */
function fit(nights: ThermalNight[]): number[] {
  const matrix = Array.from({ length: FEATURE_COUNT }, () => Array<number>(FEATURE_COUNT + 1).fill(0))
  for (const night of nights) {
    const values = features(night)
    for (let row = 0; row < FEATURE_COUNT; row++) {
      for (let column = 0; column < FEATURE_COUNT; column++) matrix[row][column] += values[row] * values[column]
      matrix[row][FEATURE_COUNT] += values[row] * night.correction
    }
  }
  for (let index = 1; index < FEATURE_COUNT; index++) matrix[index][index] += 1
  // Partial pivoting avoids unstable division when environmental features are correlated.
  for (let column = 0; column < FEATURE_COUNT; column++) {
    let pivot = column
    for (let row = column + 1; row < FEATURE_COUNT; row++) {
      if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row
    }
    ;[matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]]
    const divisor = matrix[column][column]
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-10) throw new Error('Thermal training matrix is singular.')
    for (let entry = column; entry <= FEATURE_COUNT; entry++) matrix[column][entry] /= divisor
    for (let row = 0; row < FEATURE_COUNT; row++) {
      if (row === column) continue
      const factor = matrix[row][column]
      for (let entry = column; entry <= FEATURE_COUNT; entry++) matrix[row][entry] -= factor * matrix[column][entry]
    }
  }
  return matrix.map(row => row[FEATURE_COUNT])
}

function supported(support: ThermalContext[], context: ThermalContext): boolean {
  const current = features(context)
  return support.filter((sample) => {
    const values = features(sample)
    return Math.hypot(...values.slice(1).map((value, index) => value - current[index + 1])) <= 2
  }).length >= 3
}

function predict(coefficients: number[], context: ThermalContext): number {
  return Math.max(-1, Math.min(1, features(context).reduce((total, value, index) => total + value * coefficients[index], 0)))
}

export function thermalModelHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** The newest quarter stays unseen, including during final fitting. Labels are directions, not ideal °F. */
export function trainThermalModel(input: ThermalNight[], metadata: Pick<ThermalModel, 'side' | 'createdAt' | 'datasetHash' | 'configuration'>): ThermalModel {
  if (input.length < THERMAL_MODEL_MINIMUM_NIGHTS || input.length > 90) throw new Error('At least 20 complete reviewed nights are required.')
  const dates = new Set<string>()
  for (const night of input) {
    thermalContextSchema.parse({ targetF: night.targetF, waterF: night.waterF, roomF: night.roomF, humidity: night.humidity })
    if (!date.safeParse(night.date).success || !Number.isFinite(Date.parse(night.date))
      || new Date(night.date).toISOString().slice(0, 10) !== night.date || dates.has(night.date)
      || ![-1, 0, 1].includes(night.correction)) throw new Error('Training nights must be valid, distinct and reviewed.')
    dates.add(night.date)
  }
  const nights = [...input].sort((first, second) => first.date.localeCompare(second.date))
  const heldOutCount = Math.max(5, Math.ceil(nights.length / 4))
  const training = nights.slice(0, -heldOutCount), heldOut = nights.slice(-heldOutCount)
  const coefficients = fit(training)
  const support = training.map(({ targetF, waterF, roomF, humidity }) => ({ targetF, waterF, roomF, humidity }))
  const average = training.reduce((total, night) => total + night.correction, 0) / training.length
  const residuals = heldOut.map(night => Math.abs(predict(coefficients, night) - night.correction))
  const mean = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length
  const modelMae = mean(residuals), holdMae = mean(heldOut.map(night => Math.abs(night.correction)))
  const averageMae = mean(heldOut.map(night => Math.abs(average - night.correction)))
  const baseline = Math.min(holdMae, averageMae)
  const supportedNights = heldOut.filter(night => supported(support, night)).length
  const passesFeedbackCheck = supportedNights === heldOut.length && modelMae <= baseline * 0.9 && baseline - modelMae >= 0.05
  const sortedResiduals = [...residuals].sort((first, second) => first - second)
  return thermalModelSchema.parse({ ...metadata, version: 'comfort-ridge-v1', purpose: 'morning-comfort-direction', mode: 'research_preview',
    trainingDates: training.map(night => night.date), validationDates: heldOut.map(night => night.date), coefficients, support,
    validation: { modelMae, holdMae, averageMae, residual90: sortedResiduals[Math.ceil(sortedResiduals.length * 0.9) - 1], supportedNights,
      passesFeedbackCheck, reason: supportedNights !== heldOut.length
        ? 'Later nights include conditions not represented in training.'
        : passesFeedbackCheck
          ? 'Predicted morning feedback better than both simple baselines on later nights. Sleep benefit and overnight timing remain unproven.'
          : 'The model did not beat both holding temperature and average feedback. Keep the routine.' } })
}

export function predictThermalModel(model: ThermalModel, context: ThermalContext | null) {
  const parsed = thermalModelSchema.safeParse(model)
  if (!parsed.success || !parsed.data.validation.passesFeedbackCheck) return { offsetF: null, rawDirection: null, reason: 'This model has not passed its held-out feedback comparison.' }
  if (!context || !thermalContextSchema.safeParse(context).success) return { offsetF: null, rawDirection: null, reason: 'Waiting for fresh qualified room and bed measurements.' }
  if (!supported(model.support, context)) return { offsetF: null, rawDirection: null, reason: 'Current conditions are outside the supported training examples.' }
  const rawDirection = predict(model.coefficients, context)
  if (Math.abs(rawDirection) <= model.validation.residual90) return { offsetF: null, rawDirection, reason: 'The suggested direction is smaller than the model’s held-out error. No recommendation.' }
  return { offsetF: Math.round(rawDirection), rawDirection, reason: 'Local model suggestion within 1°F. Preview only; the controller has not applied this suggestion.' }
}
