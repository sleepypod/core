import { z } from 'zod'

export const thermalContextSchema = z.object({
  targetF: z.number().min(55).max(110), waterF: z.number().min(40).max(120),
  roomF: z.number().min(40).max(100), humidity: z.number().min(0).max(100),
}).strict()
export type ThermalContext = z.infer<typeof thermalContextSchema>
export interface ThermalNight extends ThermalContext { date: string, correction: -1 | 0 | 1 }
export const thermalLearningSchema = z.object({
  model: z.literal('context-neighbors-v1'), mode: z.literal('research_preview'),
  nights: z.number().int().nonnegative(), requiredNights: z.literal(20),
  trainingNights: z.number().int().nonnegative(), validationNights: z.number().int().nonnegative(),
  modelErrorF: z.number().nullable(), baselineErrorF: z.number().nullable(),
  suggestedOffsetF: z.number().min(-1).max(1).nullable(), reason: z.string(),
})
export type ThermalLearning = z.infer<typeof thermalLearningSchema>

function distance(first: ThermalContext, second: ThermalContext) {
  // Scaling defines a similar thermal context; elapsed time and sleep stages are deliberately not guessed.
  return Math.sqrt(((first.targetF - second.targetF) / 3) ** 2
    + ((first.roomF - second.roomF) / 3) ** 2 + ((first.humidity - second.humidity) / 15) ** 2
    + (((first.waterF - first.targetF) - (second.waterF - second.targetF)) / 3) ** 2)
}
function predict(training: ThermalNight[], context: ThermalContext): number | null {
  const neighbors = training.map(night => ({ night, distance: distance(night, context) }))
    .filter(item => item.distance <= 2).sort((first, second) => first.distance - second.distance).slice(0, 7)
  if (neighbors.length < 3) return null
  const weights = neighbors.map(item => 1 / (0.25 + item.distance))
  return neighbors.reduce((total, item, index) => total + item.night.correction * weights[index], 0)
    / weights.reduce((total, weight) => total + weight, 0)
}

/** Whole-night chronological holdout. This advisory model never sends an actuator command. */
export function evaluateThermalLearning(input: ThermalNight[], context: ThermalContext | null, today: string): ThermalLearning {
  const dates = new Map<string, ThermalNight[]>()
  for (const night of input) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(night.date) || !Number.isFinite(Date.parse(night.date))
      || new Date(night.date).toISOString().slice(0, 10) !== night.date || night.date >= today
      || ![-1, 0, 1].includes(night.correction) || !thermalContextSchema.safeParse({
      targetF: night.targetF, waterF: night.waterF, roomF: night.roomF, humidity: night.humidity,
    }).success) continue
    dates.set(night.date, [...dates.get(night.date) ?? [], night])
  }
  // Ambiguous duplicate nights are excluded, never used on both sides of the split.
  const nights = [...dates.values()].filter(group => group.length === 1).map(group => group[0])
    .sort((first, second) => first.date.localeCompare(second.date))
  const report: ThermalLearning = { model: 'context-neighbors-v1', mode: 'research_preview', nights: nights.length,
    requiredNights: 20, trainingNights: 0, validationNights: 0, modelErrorF: null, baselineErrorF: null,
    suggestedOffsetF: null, reason: 'Collecting matched room readings, reported water temperatures and morning comfort check-ins. At least 20 separate nights are required.' }
  if (nights.length < 20) return report
  const validationCount = Math.max(5, Math.ceil(nights.length / 4))
  const training = nights.slice(0, -validationCount), validation = nights.slice(-validationCount)
  report.trainingNights = training.length
  report.validationNights = validation.length
  const predictions = validation.map(night => predict(training, night))
  if (predictions.some(value => value === null)) return { ...report, reason: 'Held-out nights include thermal conditions with insufficient training coverage. No recommendation.' }
  const meanCorrection = training.reduce((total, night) => total + night.correction, 0) / training.length
  const error = (values: number[]) => values.reduce((total, value, index) => total + Math.abs(value - validation[index].correction), 0) / validation.length
  report.modelErrorF = error(predictions as number[])
  report.baselineErrorF = Math.min(error(validation.map(() => 0)), error(validation.map(() => meanCorrection)))
  if (report.modelErrorF > report.baselineErrorF * 0.9 || report.baselineErrorF - report.modelErrorF < 0.05) {
    return { ...report, reason: 'The contextual model has not beaten the simpler hold-temperature or average-feedback baseline on later nights. Keep the current routine.' }
  }
  if (!context || !thermalContextSchema.safeParse(context).success) return { ...report, reason: 'Validation passed on comfort labels. Waiting for fresh thermal context; no recommendation.' }
  const proposal = predict(training, context)
  if (proposal === null) return { ...report, reason: 'Current room or bed conditions fall outside the model’s supported examples. Keep the current routine.' }
  return { ...report, suggestedOffsetF: Math.max(-1, Math.min(1, Math.round(proposal))),
    reason: 'Research suggestion only, within 1°F. Validation measures prediction of comfort feedback, not improved sleep. Your saved routine remains in control.' }
}
