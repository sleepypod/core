import { z } from 'zod'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { householdContextSchema, householdSideSchema, householdIdSchema, personalWeekSchema, personPreferencesSchema, revisionSchema } from '../contract'

const instant = z.number().int().nonnegative().max(8_640_000_000_000_000)
const side = z.enum(['left', 'right']).nullable()
const name = z.string().min(1).max(80)
const timeZone = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format(0)
    return true
  }
  catch { return false }
})

const proposalContext = householdContextSchema.extend({ version: z.literal(1), endsAt: instant })
export const temporaryProposalSchema = z.discriminatedUnion('kind', [
  proposalContext.extend({ kind: z.literal('side_swap') }).strict(),
  proposalContext.extend({ kind: z.literal('guest'), residentSide: householdSideSchema,
    acknowledgeGuestRecordingWithheld: z.literal(true) }).strict(),
])
export type TemporaryProposal = z.infer<typeof temporaryProposalSchema>
export const approveTemporaryReviewSchema = householdContextSchema.extend({
  version: z.literal(1), reviewId: householdIdSchema, issuedAt: instant, expiresAt: instant,
  confirmMySide: z.literal(true), confirmMyRoutine: z.literal(true), acknowledgeRecordingPolicy: z.literal(true),
  acknowledgeSeparateActivation: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Use a positive approval lifetime no longer than one minute.')
export const cancelTemporaryReviewSchema = householdContextSchema.extend({ version: z.literal(1), reviewId: householdIdSchema }).strict()

/** The personal response deliberately has no private partner fields or internal source snapshot. */
export const temporaryReviewSchema = z.object({
  version: z.literal(1), reviewId: householdIdSchema, kind: z.enum(['guest', 'side_swap']),
  householdId: householdIdSchema, podId: householdIdSchema, sleeperId: householdIdSchema,
  assignmentRevision: revisionSchema, timeZone,
  createdAt: instant, reviewExpiresAt: instant, intendedEnd: instant,
  state: z.enum(['awaiting_approval', 'approved_for_separate_activation', 'expired', 'stale', 'cancelled', 'consumed']),
  self: z.object({ displayName: name, assignmentAtReview: z.enum(['solo', 'left', 'right', 'unassigned']), proposedSide: side,
    originalOperatingWeek: personalWeekSchema, operatingWeek: personalWeekSchema, preferences: personPreferencesSchema,
    approvalRequired: z.literal(true), approved: z.boolean() }).strict(),
  others: z.array(z.object({ displayName: name, proposedSide: side, approvalRequired: z.literal(true), approved: z.boolean() }).strict()).max(1),
  guestSide: side,
  recordingPolicy: z.enum(['withhold_personal_records_for_guest_interval', 'reviewed_assignments_after_new_epoch']),
  learningPolicy: z.literal('paused_until_reviewed_return'), sharedActionPolicy: z.literal('quiet_until_reviewed_return'),
  returnPolicy: z.literal('fresh_review_never_automatic_reversion'),
  canApprove: z.boolean(), canCancel: z.boolean(), canActivate: z.literal(false), effect: z.literal('review_only_bed_unchanged'),
}).strict()
export type TemporaryReview = z.infer<typeof temporaryReviewSchema>
