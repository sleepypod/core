import { z } from 'zod'
import { experimentContextSchema, experimentDateSchema, experimentFeedbackSchema, experimentHashSchema,
  experimentInstantSchema, experimentPlanSchema, experimentProposalSchema, experimentRecordSchema, experimentScheduleSchema } from './contract'
import { experimentNights } from './nights'

const identifier = z.string().uuid()
export const experimentBrowserScopeSchema = z.union([
  z.object({ kind: z.literal('legacy'), installationId: identifier }).strict(),
  z.object({ kind: z.literal('personal'), podId: identifier, householdId: identifier, accountId: identifier,
    sleeperId: identifier, sessionRevision: z.number().int().positive(), assignmentRevision: z.number().int().positive(),
    householdRevision: z.number().int().positive() }).strict(),
])
export type ExperimentBrowserScope = z.infer<typeof experimentBrowserScopeSchema>
const envelope = z.object({ version: z.literal(1), generatedAt: experimentInstantSchema,
  scope: experimentBrowserScopeSchema, execution: z.literal('planning_only') })
const availability = z.object({ context: experimentContextSchema.nullable(), reason: z.string().max(2000) }).strict()
const metadata = z.object({ id: identifier, revision: identifier, status: z.enum(['planned', 'stopped']),
  createdAt: experimentInstantSchema, updatedAt: experimentInstantSchema, firstNightDate: experimentDateSchema,
  baselineF: z.number().int().min(55).max(110), variantF: z.number().int().min(55).max(110), contextCurrent: z.boolean() }).strict()
export const experimentLibrarySchema = envelope.extend({ availability, nextId: identifier.nullable(), experiments: z.array(metadata).max(20) }).strict()
const night = z.object({ date: experimentDateSchema, pair: z.number().int().min(0).max(3), period: z.number().int().min(0).max(1),
  role: z.enum(['settling', 'scored']), arm: z.enum(['baseline', 'variant']), targetF: z.number().int().min(55).max(110) }).strict()
export const experimentReviewSchema = envelope.extend({ availability, reviewId: identifier, planHash: experimentHashSchema,
  expiresAt: experimentInstantSchema, plan: experimentPlanSchema, nights: z.array(night).length(16), schedule: experimentScheduleSchema,
  notice: z.string().max(2000) }).strict()
const count = z.number().int().min(0).max(16)
const arm = z.object({ assigned: count, scored: count, usable: count, missing: count, meanComfort: z.number().min(0).max(10).nullable() }).strict()
export const experimentDetailSchema = envelope.extend({ record: experimentRecordSchema, contextCurrent: z.boolean(), contextReason: z.string().max(2000),
  comparison: z.object({ nights: z.array(night.extend({ usable: z.boolean(), exclusions: z.array(z.enum([
    'missing_exposure', 'source_withdrawn', 'context_changed', 'preview_only', 'wrong_window', 'wake_overlap', 'wrong_target',
    'insufficient_coverage', 'manual_change', 'uncertain_command', 'safety_interruption', 'ambiguous_sleeper',
    'missing_feedback', 'partial_night', 'invalid_feedback_clock', 'settling_unverified',
  ])).max(16), comfort: z.number().min(0).max(10).nullable(), unwantedAdjustments: z.number().int().nonnegative().nullable(), problem: z.boolean().nullable() })).length(16),
  arms: z.object({ baseline: arm, variant: arm }).strict(),
  pairedDifferences: z.array(z.object({ pair: z.number().int().min(0).max(3), comfort: z.number().min(-10).max(10), unwantedAdjustments: z.number().int() }).strict()).max(4),
  meanPairedComfortDifference: z.number().min(-10).max(10).nullable(),
  recommendation: z.enum(['consider_variant', 'keep_baseline', 'inconclusive']), reason: z.string().max(2000),
  interpretation: z.literal('personal_comfort_comparison_not_sleep_or_causal_proof') }).strict(),
}).strict()
export type ExperimentLibrary = z.infer<typeof experimentLibrarySchema>
export type ExperimentReview = z.infer<typeof experimentReviewSchema>
export type ExperimentDetail = z.infer<typeof experimentDetailSchema>
export const experimentConfirmationSchema = z.object({ reviewId: identifier, planHash: experimentHashSchema }).strict()
export const experimentStopSchema = z.object({ expectedRevision: identifier }).strict()
export const experimentFeedbackWriteSchema = experimentStopSchema.extend({ feedback: experimentFeedbackSchema.omit({ recordedAt: true }) }).strict()

export function sameExperimentScope(first: ExperimentBrowserScope, second: ExperimentBrowserScope) {
  return JSON.stringify(experimentBrowserScopeSchema.parse(first)) === JSON.stringify(experimentBrowserScopeSchema.parse(second))
}

/** Check scope and clocks before returning any private response to the view. */
export function readExperimentEnvelope<Schema extends z.ZodType<{ scope: ExperimentBrowserScope, generatedAt: number }>>(
  schema: Schema, input: unknown, scope: ExperimentBrowserScope, now: number,
): z.output<Schema> {
  const value = schema.parse(input)
  if (!sameExperimentScope(scope, value.scope) || value.generatedAt > now + 60000 || value.generatedAt < now - 120000)
    throw new Error('Experiment account or response time changed.')
  return value
}

export function validateExperimentDetail(value: ExperimentDetail, id: string): ExperimentDetail {
  const { record, comparison } = value
  if (record.plan.id !== id || record.updatedAt > value.generatedAt
    || JSON.stringify(comparison.nights.map(({ date, pair, period, role, arm, targetF }) => ({ date, pair, period, role, arm, targetF }))) !== JSON.stringify(experimentNights(record.plan)))
    throw new Error('The saved comparison could not be verified.')
  return value
}

/** Shared allowlist for the owner and personal browser transports. No actuator or evidence-upload route exists. */
export function experimentBrowserRequest(path: string, method: string, body?: unknown) {
  if (path.includes('#')) return false
  const [pathname, query, extra] = path.split('?')
  if (extra !== undefined) return false
  try {
    if (method === 'GET' && body === undefined) {
      if (!pathname) {
        if (query === undefined) return true
        const entries = [...new URLSearchParams(query)]
        return entries.length === 1 && entries[0][0] === 'afterId' && identifier.safeParse(entries[0][1]).success
      }
      return query === undefined && identifier.safeParse(pathname).success
    }
    if (method !== 'POST' || query !== undefined) return false
    if (pathname === 'preview') return experimentProposalSchema.safeParse(body).success
    if (pathname === 'confirm') return experimentConfirmationSchema.safeParse(body).success
    const [id, action, trailing] = pathname.split('/')
    if (trailing !== undefined || !identifier.safeParse(id).success) return false
    return action === 'stop'
      ? experimentStopSchema.safeParse(body).success
      : action === 'feedback' && experimentFeedbackWriteSchema.safeParse(body).success
  }
  catch { return false }
}
