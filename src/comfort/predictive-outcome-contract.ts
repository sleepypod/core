import { z } from 'zod'

export const predictiveOutcomeReasons = {
  no_forecast: 'No complete unchanged-target forecast was recorded.',
  no_review: 'The complete night needs a current review and matching source configuration.',
  context_changed: 'Quiet occupied room observations are missing, interrupted or changed.',
  target_changed: 'The reported target, power state or water observations changed or became unavailable.',
  command_changed: 'A target request, manual action or unresolved command overlaps the observation window.',
  outcome_missing: 'Actual measurements at the prediction origin or either later horizon are missing.',
} as const
export type PredictiveOutcomeReason = keyof typeof predictiveOutcomeReasons
const count = z.number().int().nonnegative()
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.number().int().positive().max(8_640_000_000_000_000)
const metric = z.number().finite().nonnegative()
export const predictiveOutcomeSchema = z.object({
  apiVersion: z.literal(1), side: z.enum(['left', 'right']), generatedAt: instant,
  purpose: z.literal('prospective_water_accuracy'), activationAvailable: z.literal(false),
  considered: count, pending: count, withheld: count, scored: count,
  models: z.array(z.object({
    artifactId: digest, datasetHash: digest, configuration: digest, latestAt: instant,
    comparisons: count.positive(), reviewedNights: count.positive(),
    horizons: z.array(z.object({
      minutes: z.union([z.literal(15), z.literal(30)]),
      meanNightErrorF: metric, meanNightPersistenceErrorF: metric,
      meanNightRangeCoverage: z.number().finite().min(0).max(1),
    }).strict()).length(2),
  }).strict()).max(32),
  exclusions: z.array(z.object({ code: z.enum(Object.keys(predictiveOutcomeReasons) as [PredictiveOutcomeReason, ...PredictiveOutcomeReason[]]), count: count.positive() }).strict()).max(6),
  notice: z.literal('Only the unchanged target is scored. Unapplied alternatives have no measured outcome, and water accuracy is not evidence of better sleep.'),
}).strict().superRefine((value, context) => {
  const invalid = () => context.addIssue({ code: 'custom', message: 'Prospective outcome counts or clocks are inconsistent.' })
  if (value.considered !== value.pending + value.withheld + value.scored
    || value.models.reduce((total, model) => total + model.comparisons, 0) !== value.scored
    || value.exclusions.reduce((total, item) => total + item.count, 0) !== value.withheld) invalid()
  const identities = value.models.map(model => JSON.stringify([model.artifactId, model.datasetHash, model.configuration]))
  if (new Set(identities).size !== identities.length) invalid()
  if (new Set(value.exclusions.map(item => item.code)).size !== value.exclusions.length) invalid()
  for (const model of value.models) {
    if (model.latestAt >= value.generatedAt || model.reviewedNights > model.comparisons
      || model.horizons[0]?.minutes !== 15 || model.horizons[1]?.minutes !== 30) invalid()
  }
})
export type PredictiveOutcomeSummary = z.infer<typeof predictiveOutcomeSchema>
export const predictiveOutcomeRequestSchema = z.object({ version: z.literal(1), operation: z.literal('outcomes'),
  side: z.enum(['left', 'right']), at: instant }).strict()
export const predictiveOutcomeResultSchema = z.object({ version: z.literal(1), requestHash: digest, data: predictiveOutcomeSchema }).strict()
