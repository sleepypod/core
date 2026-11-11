import { z } from 'zod'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { householdContextSchema, householdIdSchema } from './contract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
export const arrangementRestartRequestSchema = householdContextSchema.extend({
  version: z.literal(1), operationId: householdIdSchema, issuedAt: instant, expiresAt: instant,
  confirmEmptyAndAttended: z.literal(true), acknowledgeConnectionWillClose: z.literal(true),
  acknowledgeControlsRemainPaused: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Use a fresh attended restart request lasting at most 60 seconds.')
export type ArrangementRestartRequest = z.infer<typeof arrangementRestartRequestSchema>

export const arrangementRestartReceiptSchema = z.object({
  operationId: householdIdSchema, requestId: householdIdSchema,
  state: z.enum(['requested', 'submitted', 'unconfirmed']), requestedAt: instant, resultAt: instant.nullable(),
  hardware: z.literal('held_for_runtime_recovery'), replayAllowed: z.literal(false),
}).strict().refine(value => (value.state === 'requested') === (value.resultAt === null)
  && (value.resultAt === null || value.resultAt >= value.requestedAt))
export type ArrangementRestartReceipt = z.infer<typeof arrangementRestartReceiptSchema>
