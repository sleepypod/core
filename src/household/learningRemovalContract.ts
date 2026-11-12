import { z } from 'zod'
import { householdContextSchema, householdIdSchema } from './contract'
import { personalHistoryScopeSchema } from './historyApiContract'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.number().int().positive().max(8_640_000_000_000_000)

export const learningRemovalRequestSchema = householdContextSchema.extend({
  version: z.literal(1), recordId: householdIdSchema, archiveId: householdIdSchema,
  expectedPayloadHash: digest, confirmRemoveArchivedCopy: z.literal(true),
}).strict()

export const learningRemovalReceiptSchema = z.object({
  requestId: householdIdSchema, recordId: householdIdSchema, archiveId: householdIdSchema,
  payloadHash: digest, removedAt: instant, outcome: z.literal('content_removed'),
}).strict()

export const learningRemovalResponseSchema = z.object({
  version: z.literal(1), generatedAt: instant, scope: personalHistoryScopeSchema,
  interpretation: z.literal('archived_copy_removal_not_source_deletion'),
  receipt: learningRemovalReceiptSchema.nullable(),
}).strict().refine(value => !value.receipt || value.receipt.removedAt <= value.generatedAt,
  'Removal receipt cannot be from the future.')

export type LearningRemovalRequest = z.infer<typeof learningRemovalRequestSchema>
export type LearningRemovalReceipt = z.infer<typeof learningRemovalReceiptSchema>
