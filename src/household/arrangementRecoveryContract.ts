import { z } from 'zod'
import { MAX_CONTROL_LIFETIME_MS } from '@/src/controls/contract'
import { controllerGenerationSchema } from '@/src/lib/controllerGenerationContract'
import { householdContextSchema, householdIdSchema, revisionSchema } from './contract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

/** A new attended request is required after restart; the original activation request cannot release controls. */
export const arrangementRecoveryRequestSchema = householdContextSchema.extend({
  version: z.literal(1), operationId: householdIdSchema, issuedAt: instant, expiresAt: instant,
  confirmEmptyAndAttended: z.literal(true), confirmAssignedSides: z.literal(true),
  acknowledgeRecordingGap: z.literal(true), acknowledgeLearningRemainsOff: z.literal(true),
}).strict().refine(value => value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_CONTROL_LIFETIME_MS,
  'Use a fresh attended recovery request lasting at most 60 seconds.')
export type ArrangementRecoveryRequest = z.infer<typeof arrangementRecoveryRequestSchema>

export const arrangementRecoveryReceiptSchema = z.object({
  operationId: householdIdSchema, requestId: householdIdSchema, reviewId: householdIdSchema,
  state: z.literal('completed'), completedAt: instant, admissionRevision: revisionSchema,
  epochId: householdIdSchema, recordingStartsAt: instant,
  hardware: z.literal('admission_released'), physicalMovement: z.literal('not_requested'),
}).strict()
export type ArrangementRecoveryReceipt = z.infer<typeof arrangementRecoveryReceiptSchema>

/** Private recovery evidence stays on the controller; clients receive only the concise receipt. */
export const savedArrangementRecoverySchema = z.object({
  request: arrangementRecoveryRequestSchema, requestHash: digest,
  receipt: arrangementRecoveryReceiptSchema, controller: controllerGenerationSchema,
  processing: z.object({ earliestAssignedSampleAt: instant, receipts: z.array(z.object({
    component: z.enum(['sleep-detector', 'piezo-processor']), process_id: householdIdSchema,
    intent_hash: digest, first_sample_ms: instant, latest_sample_ms: instant, heartbeat_at_ms: instant,
  }).strict()).length(2) }).strict(),
}).strict()
