import { z } from 'zod'
import { householdContextSchema, householdIdSchema } from './contract'
import { personalHistoryScopeSchema } from './historyApiContract'

export const QUIET_MAX_DURATION_MS = 24 * 60 * 60 * 1000
export const QUIET_REQUEST_LIFETIME_MS = 60_000
export const QUIET_OBSERVATION_LIFETIME_MS = 15_000
export const quietInstantSchema = z.number().int().nonnegative().max(253402300799000)

// Each person owns one request. Clearing it cannot cancel the other person's rest.
export const quietWriteSchema = householdContextSchema.extend({
  expectedRevision: householdIdSchema.nullable(),
  issuedAt: quietInstantSchema, expiresAt: quietInstantSchema,
  until: quietInstantSchema.nullable(),
}).strict().refine(value => value.expiresAt > value.issuedAt
  && value.expiresAt - value.issuedAt <= QUIET_REQUEST_LIFETIME_MS
  && (value.until === null || (value.until > value.issuedAt && value.until - value.issuedAt <= QUIET_MAX_DURATION_MS)),
'Choose a future quiet end within 24 hours and a request lifetime of at most one minute.')

export const quietSelectionSchema = z.object({
  revision: householdIdSchema.nullable(), until: quietInstantSchema.nullable(),
}).strict()
export const sharedQuietSchema = z.object({
  paused: z.boolean(), until: quietInstantSchema.nullable(),
}).strict().refine(value => value.paused === (value.until !== null), 'Shared quiet state is inconsistent.')

/** Installation clients need only the union of quiet requests, never personal identities. */
export const sharedQuietReadSchema = z.object({
  version: z.literal(1), generatedAt: quietInstantSchema, expiresAt: quietInstantSchema, shared: sharedQuietSchema,
}).strict().refine(value => value.expiresAt === value.generatedAt + QUIET_OBSERVATION_LIFETIME_MS
  && (value.shared.until === null || value.shared.until > value.generatedAt), 'Shared quiet reading is inconsistent.')
export const quietReceiptSchema = z.object({
  requestId: householdIdSchema, revision: householdIdSchema,
  savedAt: quietInstantSchema, until: quietInstantSchema.nullable(),
}).strict().refine(value => value.until === null || (value.until > value.savedAt && value.until - value.savedAt <= QUIET_MAX_DURATION_MS),
  'Quiet receipt clocks are inconsistent.')
const envelope = { version: z.literal(1), generatedAt: quietInstantSchema, scope: personalHistoryScopeSchema }
export const quietReadResponseSchema = z.object({ ...envelope, mine: quietSelectionSchema, shared: sharedQuietSchema }).strict()
  .refine(value => (value.mine.until === null || value.mine.until > value.generatedAt)
    && (value.shared.until === null || value.shared.until > value.generatedAt), 'Quiet status has expired.')
export const quietWriteResponseSchema = z.object({ ...envelope, receipt: quietReceiptSchema.nullable() }).strict()
  .refine(value => value.receipt === null || value.receipt.savedAt <= value.generatedAt, 'The receipt is newer than the response clock.')
export type SharedQuiet = z.infer<typeof sharedQuietSchema>
