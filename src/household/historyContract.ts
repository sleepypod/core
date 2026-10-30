import { z } from 'zod'
import { householdIdSchema, householdSideSchema, revisionSchema } from './contract'

// All timestamps in this boundary are UTC milliseconds. Source adapters must
// convert their own units and supply the full measurement interval explicitly.
export const historyTimeSchema = z.number().int().min(0).max(8_640_000_000_000_000)
export const historyKindSchema = z.enum(['presence', 'vitals', 'movement'])
const assignmentSchema = z.object({ sleeperId: householdIdSchema, recordedSide: householdSideSchema }).strict()
export const attributionEpochSchema = z.object({
  householdId: householdIdSchema, datasetId: householdIdSchema,
  expectedAttributionRevision: revisionSchema,
  startsAt: historyTimeSchema, endsAt: historyTimeSchema.nullable(),
  mode: z.enum(['solo_merged', 'assigned']),
  assignments: z.array(assignmentSchema).min(1).max(2),
  basis: z.enum(['legacy_owner_review', 'verified_arrangement']),
  reviewReceiptId: householdIdSchema, reviewedBy: householdIdSchema,
}).strict().superRefine((value, context) => {
  if (value.endsAt !== null && value.endsAt <= value.startsAt)
    context.addIssue({ code: 'custom', message: 'An attribution interval must have positive length.' })
  if (new Set(value.assignments.map(entry => entry.recordedSide)).size !== value.assignments.length
    || new Set(value.assignments.map(entry => entry.sleeperId)).size !== value.assignments.length
    || (value.mode === 'solo_merged' && value.assignments.length !== 1))
    context.addIssue({ code: 'custom', message: 'Each recorded zone has one distinct sleeper; a merged solo source has one assignment.' })
})
export type AttributionEpochInput = z.infer<typeof attributionEpochSchema>

const presenceSchema = z.object({
  kind: z.literal('presence'),
  reportedPresenceSeconds: z.number().finite().nonnegative().max(86400),
  exits: z.number().int().nonnegative().max(10000),
  interpretation: z.literal('bed_presence_not_sleep'),
}).strict()
const vitalsSchema = z.object({
  kind: z.literal('vitals'), heartRateBpm: z.number().finite().positive().max(300).nullable(),
  breathingRatePerMinute: z.number().finite().positive().max(100).nullable(),
  hrvMs: z.number().finite().nonnegative().max(2000).nullable(),
  hrvMetric: z.enum(['window_ibi_variability_v1', 'unknown']),
}).strict()
const movementSchema = z.object({
  kind: z.literal('movement'), total: z.number().finite().nonnegative(),
  interpretation: z.literal('movement_not_sleep_stage'),
}).strict()
export const personalHistoryPayloadSchema = z.discriminatedUnion('kind', [presenceSchema, vitalsSchema, movementSchema])
export const sourceObservationSchema = z.object({
  householdId: householdIdSchema, datasetId: householdIdSchema,
  sourceRecordKey: z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  recordedSide: householdSideSchema, startsAt: historyTimeSchema, endsAt: historyTimeSchema,
  payload: personalHistoryPayloadSchema,
}).strict().superRefine((value, context) => {
  const duration = value.endsAt - value.startsAt
  if (duration <= 0 || duration > 86400_000)
    context.addIssue({ code: 'custom', message: 'Use a complete source interval of at most 24 hours.' })
  if (value.payload.kind === 'presence' && value.payload.reportedPresenceSeconds * 1000 > duration)
    context.addIssue({ code: 'custom', message: 'Reported presence cannot exceed the source interval.' })
})
export type SourceObservation = z.infer<typeof sourceObservationSchema>

export const personalHistoryRangeSchema = z.object({
  startsAt: historyTimeSchema, endsAt: historyTimeSchema,
  kind: historyKindSchema, limit: z.number().int().min(1).max(100).default(30),
}).strict()
export const personalHistoryQuerySchema = personalHistoryRangeSchema.extend({
  cursor: z.string().min(1).max(4096).optional(),
}).strict().refine(value => value.endsAt > value.startsAt && value.endsAt - value.startsAt <= 90 * 86400_000,
  'Choose a positive history range of at most 90 days.')
export type PersonalHistoryQuery = z.infer<typeof personalHistoryQuerySchema>

export const personalHistoryRecordSchema = z.object({
  id: householdIdSchema, sleeperId: householdIdSchema,
  startsAt: historyTimeSchema, endsAt: historyTimeSchema,
  recordedSide: householdSideSchema, payload: personalHistoryPayloadSchema,
  attribution: z.object({
    epochId: householdIdSchema, mode: z.enum(['solo_merged', 'assigned']),
    basis: z.enum(['legacy_owner_review', 'verified_arrangement']),
    identity: z.literal('reviewed_arrangement_not_biometric_identification'),
  }).strict(),
}).strict().superRefine((value, context) => {
  const duration = value.endsAt - value.startsAt
  if (duration <= 0 || duration > 86400_000
    || (value.payload.kind === 'presence' && value.payload.reportedPresenceSeconds * 1000 > duration))
    context.addIssue({ code: 'custom', message: 'A complete recording needs a valid interval and bounded presence duration.' })
})
export type PersonalHistoryRecord = z.infer<typeof personalHistoryRecordSchema>
