import { z } from 'zod'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { controllerGenerationSchema } from '@/src/lib/controllerGenerationContract'
import { householdContextSchema, householdIdSchema, revisionSchema } from './contract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

/** Cancellation reviews the current solo controls, not a stale copy from when the hold began. */
export const arrangementCancellationRequestSchema = householdContextSchema.extend({
  version: z.literal(1), operationId: householdIdSchema, issuedAt: instant, expiresAt: instant,
  expectedControlDigest: digest, confirmEmptyAndAttended: z.literal(true),
  confirmKeepSoloArrangement: z.literal(true), acknowledgeSavedRoutinesMayResume: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Use a fresh attended cancellation request lasting at most 60 seconds.')
export type ArrangementCancellationRequest = z.infer<typeof arrangementCancellationRequestSchema>

export const arrangementCancellationReceiptSchema = z.object({
  operationId: householdIdSchema, requestId: householdIdSchema, reviewId: householdIdSchema,
  state: z.literal('cancelled'), completedAt: instant, admissionRevision: revisionSchema,
  controlDigest: digest, arrangement: z.literal('solo-anywhere'),
  hardware: z.literal('admission_released'), physicalMovement: z.literal('not_requested'),
}).strict()
export type ArrangementCancellationReceipt = z.infer<typeof arrangementCancellationReceiptSchema>

export const arrangementCancellationPreviewSchema = z.object({
  operationId: householdIdSchema, expectedSessionRevision: revisionSchema, expectedAssignmentRevision: revisionSchema,
  controlDigest: digest, observedAt: instant,
}).strict()
export type ArrangementCancellationPreview = z.infer<typeof arrangementCancellationPreviewSchema>

export const savedArrangementCancellationSchema = z.object({
  request: arrangementCancellationRequestSchema, requestHash: digest,
  receipt: arrangementCancellationReceiptSchema, controller: controllerGenerationSchema,
}).strict()
