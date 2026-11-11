import { z } from 'zod'
import { householdIdSchema, revisionSchema } from './contract'
import { arrangementRecoveryReceiptSchema } from './arrangementRecoveryContract'
import { arrangementCancellationReceiptSchema } from './arrangementCancellationContract'
import { arrangementRestartReceiptSchema } from './arrangementRestartContract'

const instant = z.number().int().positive().max(8_640_000_000_000_000)

/** Public recovery state contains no archived preferences, raw processing receipts or device secrets. */
export const arrangementMaintenanceStatusSchema = z.object({
  version: z.literal(1), observedAt: instant,
  expectedSessionRevision: revisionSchema, expectedAssignmentRevision: revisionSchema,
  operation: z.object({
    operationId: householdIdSchema, reviewId: householdIdSchema,
    state: z.enum(['held', 'committed', 'completed', 'cancelled']),
    createdAt: instant, committedAt: instant.nullable(),
    controllerRestarted: z.boolean().nullable(),
    admission: z.enum(['held_for_this_transition', 'held_for_another_transition', 'open', 'unavailable']),
    recovery: arrangementRecoveryReceiptSchema.nullable(),
    cancellation: arrangementCancellationReceiptSchema.nullable(),
    restart: arrangementRestartReceiptSchema.nullable(),
  }).strict().nullable(),
}).strict()
export type ArrangementMaintenanceStatus = z.infer<typeof arrangementMaintenanceStatusSchema>
