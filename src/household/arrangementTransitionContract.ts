import { z } from 'zod'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { householdContextSchema, householdIdSchema } from './contract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
/** Internal coordinator input. No route accepts this until runtime recovery and UI review are complete. */
export const arrangementTransitionRequestSchema = householdContextSchema.extend({
  version: z.literal(1), reviewId: householdIdSchema, issuedAt: instant, expiresAt: instant,
  confirmEmptyAndAttended: z.literal(true), confirmClearTemporaryActions: z.literal(true),
  confirmPauseLearningAndSharedAutomations: z.literal(true), acknowledgeHeldUntilRecovery: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Use a fresh attended request lasting at most 60 seconds.')
export type ArrangementTransitionRequest = z.infer<typeof arrangementTransitionRequestSchema>

/** Observations come from independent server readers, never the request's assertion of an empty bed. */
export const arrangementObservationSchema = z.object({
  runId: householdIdSchema,
  presence: z.object({ observedAt: instant, left: z.literal('empty'), right: z.literal('empty') }).strict(),
  thermal: z.object({ observedAt: instant, leftPowered: z.literal(false), rightPowered: z.literal(false),
    water: z.literal('ok'), priming: z.literal(false) }).strict(),
  alarm: z.object({ observedAt: instant, vibrating: z.literal(false), snoozing: z.literal(false) }).strict(),
  base: z.object({ observedAt: instant, state: z.enum(['stationary', 'unsupported']) }).strict(),
}).strict()
export type ArrangementObservation = z.infer<typeof arrangementObservationSchema>

export interface ArrangementTransitionReceipt {
  operationId: string
  reviewId: string
  state: 'held' | 'committed'
  admissionRevision: number
  createdAt: number
  committedAt: number | null
  hardware: 'held_for_runtime_recovery'
}
