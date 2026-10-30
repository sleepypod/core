import { z } from 'zod'
import { routineDaySchema, routineSnapshotSchema } from '@/src/lib/bedtimeRoutines'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { householdIdSchema, householdSideSchema, personalWeekSchema, revisionSchema } from './contract'
import { personalControlScopeSchema } from './controlContract'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.number().int().positive().max(8_640_000_000_000_000)
const changeSchema = z.object({ dayOfWeek: routineDaySchema, operation: z.enum(['create', 'replace', 'remove']) }).strict()

export const personalRoutineReviewSchema = z.object({
  version: z.literal(1), scope: personalControlScopeSchema,
  sourceSide: householdSideSchema, temperatureZones: z.array(householdSideSchema).min(1).max(2),
  timeZone: z.string().min(1).max(100), draftRevision: revisionSchema,
  liveRevision: digest, reviewRevision: digest,
  liveWeek: z.array(routineSnapshotSchema).max(7), draftWeek: personalWeekSchema,
  changes: z.array(changeSchema).max(7), canPublish: z.boolean(),
  reason: z.enum(['ready', 'unchanged', 'draft_not_prepared', 'calendar_migration_required', 'publication_disabled']),
  effect: z.literal('saved_routines_can_affect_the_current_target'),
}).strict()
export type PersonalRoutineReview = z.infer<typeof personalRoutineReviewSchema>

export const personalRoutinePublishSchema = z.object({
  version: z.literal(1), requestId: householdIdSchema, scope: personalControlScopeSchema,
  issuedAt: instant, expiresAt: instant, reviewRevision: digest,
  confirmReplaceLiveWeek: z.literal(true), acknowledgeCurrentTargetEffect: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Publication lifetime must be positive and no more than 60 seconds.')
export type PersonalRoutinePublish = z.infer<typeof personalRoutinePublishSchema>

export const personalRoutineReceiptSchema = z.object({
  version: z.literal(1), requestId: householdIdSchema, scope: personalControlScopeSchema,
  sourceSide: householdSideSchema, publishedAt: instant, draftRevision: revisionSchema,
  reviewRevision: digest, state: z.literal('saved'),
  scheduler: z.enum(['pending', 'refreshed', 'unconfirmed']),
  publishedWeek: z.array(routineSnapshotSchema).max(7),
  changes: z.array(changeSchema).min(1).max(7),
  physicalVerification: z.literal('unverified'), replayAllowed: z.literal(false),
}).strict()
export type PersonalRoutineReceipt = z.infer<typeof personalRoutineReceiptSchema>
