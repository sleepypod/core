import { z } from 'zod'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { householdContextSchema, householdIdSchema, householdSideSchema, personalWeekSchema, personPreferencesSchema, revisionSchema } from './contract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
const timeZone = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  }
  catch { return false }
}, 'A valid time zone is required.')
export const proposeArrangementSchema = householdContextSchema.extend({
  version: z.literal(1), ownerSide: householdSideSchema,
  confirmPreserveOperatingOwnerWeek: z.literal(true),
}).strict()

export const approveArrangementSchema = householdContextSchema.extend({
  version: z.literal(1), reviewId: householdIdSchema,
  issuedAt: instant, expiresAt: instant,
  confirmMySide: z.literal(true), confirmMyRoutine: z.literal(true),
  acknowledgeSeparateActivation: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Approval lifetime must be positive and no more than 60 seconds.')

export const cancelArrangementSchema = householdContextSchema.extend({
  version: z.literal(1), reviewId: householdIdSchema,
}).strict()

export const arrangementReviewSchema = z.object({
  version: z.literal(1), reviewId: householdIdSchema,
  householdId: householdIdSchema, podId: householdIdSchema,
  sleeperId: householdIdSchema, assignmentRevision: revisionSchema,
  createdAt: instant, expiresAt: instant, timeZone,
  state: z.enum(['awaiting_approval', 'approved_for_separate_activation', 'stale', 'expired', 'cancelled', 'consumed']),
  self: z.object({
    displayName: z.string(), assignmentAtReview: z.enum(['solo', 'unassigned']), proposedSide: householdSideSchema,
    routineSource: z.enum(['preserved_operating_week', 'own_private_draft']),
    week: personalWeekSchema, preferences: personPreferencesSchema,
    approved: z.boolean(),
  }).strict(),
  // Shared names, physical sides and readiness only. No partner routine/Health data.
  partner: z.object({ displayName: z.string(), proposedSide: householdSideSchema, approved: z.boolean() }).strict(),
  canApprove: z.boolean(), canActivate: z.literal(false),
  effect: z.literal('review_only_bed_unchanged'),
}).strict()
export type ArrangementReview = z.infer<typeof arrangementReviewSchema>
export const arrangementIndexSchema = z.object({ version: z.literal(1), review: arrangementReviewSchema.nullable() }).strict()
