import { z } from 'zod'

const temperature = z.number().finite().min(50).max(115)
export const predictiveHorizonsSchema = z.array(z.object({
  minutes: z.union([z.literal(15), z.literal(30)]), waterF: temperature,
  lowerF: temperature, upperF: temperature,
}).strict().refine(value => value.lowerF <= value.waterF && value.waterF <= value.upperF,
  'The estimate must lie within its error range.')).length(2)
  .refine(values => values[0]?.minutes === 15 && values[1]?.minutes === 30, 'Both horizons are required in order.')

const comparisonSchema = z.object({
  targetF: z.number().int().min(55).max(110), kind: z.enum(['hold', 'step']),
  predictions: predictiveHorizonsSchema.or(z.array(z.never()).length(0)),
  bestErrorF: z.number().finite().nonnegative().nullable(),
  worstErrorF: z.number().finite().nonnegative().nullable(),
  reason: z.string(),
}).strict().refine(value => (value.predictions.length === 2) === (value.bestErrorF !== null && value.worstErrorF !== null)
  && (value.bestErrorF === null || (value.worstErrorF !== null && value.bestErrorF <= value.worstErrorF)),
'Only complete forecasts may carry a tracking score.')

export const predictiveTargetPreviewSchema = z.object({
  apiVersion: z.literal(1), policy: z.literal('bounded-water-tracking-v1'),
  side: z.enum(['left', 'right']), generatedAt: z.number().int().positive(),
  mode: z.literal('research_preview'), activationAvailable: z.literal(false),
  objective: z.literal('bounded-routine-water-target'),
  disposition: z.enum(['withheld', 'hold', 'candidate']),
  currentTargetF: z.number().int().min(55).max(110).nullable(),
  desiredWaterF: z.number().finite().min(55).max(110).nullable(),
  proposedTargetF: z.number().int().min(55).max(110).nullable(),
  expiresAt: z.number().int().positive().nullable(),
  minimumF: z.number().int().min(55).max(110).nullable(),
  maximumF: z.number().int().min(55).max(110).nullable(),
  comparisons: z.array(comparisonSchema).max(3), reason: z.string(),
}).strict().superRefine((value, context) => {
  const targets = value.comparisons.map(item => item.targetF)
  const hold = value.comparisons.find(item => item.kind === 'hold')
  const invalid = (message: string) => context.addIssue({ code: 'custom', message })
  if (new Set(targets).size !== targets.length || value.comparisons.filter(item => item.kind === 'hold').length > 1
    || (hold && hold.targetF !== value.currentTargetF)) invalid('Comparisons must contain distinct nearby targets and the actual hold target.')
  if (value.comparisons.some(item => value.currentTargetF === null || (item.kind === 'step'
    && Math.abs(item.targetF - value.currentTargetF) !== 1))) invalid('Step comparisons must be exactly one degree away.')
  if (value.disposition === 'withheld') {
    if (value.proposedTargetF !== null || value.expiresAt !== null) invalid('A withheld preview cannot carry a target or validity period.')
    return
  }
  if (!hold || hold.predictions.length !== 2 || value.currentTargetF === null || value.desiredWaterF === null
    || value.minimumF === null || value.maximumF === null || value.minimumF > value.maximumF
    || value.proposedTargetF === null || value.proposedTargetF < value.minimumF || value.proposedTargetF > value.maximumF
    || value.desiredWaterF < value.minimumF || value.desiredWaterF > value.maximumF
    || value.expiresAt === null || value.expiresAt <= value.generatedAt || value.expiresAt - value.generatedAt > 15_000) {
    invalid('A research selection requires a complete hold comparison, bounded targets and a fresh expiry.')
  }
  const selection = value.comparisons.find(item => item.targetF === value.proposedTargetF)
  if (!selection || selection.predictions.length !== 2
    || (value.disposition === 'hold') !== (selection.kind === 'hold')) invalid('The selection must identify a complete comparison of the stated kind.')
})
export type PredictiveTargetPreview = z.infer<typeof predictiveTargetPreviewSchema>
