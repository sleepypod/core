import { z } from 'zod'
import { experimentHashSchema, experimentInstantSchema } from './contract'

const identifier = z.string().uuid()
const side = z.enum(['left', 'right'])
const sides = z.array(side).min(1).max(2).refine(value => new Set(value).size === value.length)

export const experimentExecutionConfirmationSchema = z.object({
  reviewId: identifier, planHash: experimentHashSchema, confirmed: z.literal(true),
}).strict()
export const experimentExecutionCancellationSchema = z.object({ admissionId: identifier }).strict()
export const experimentExecutionRecoverySchema = experimentExecutionCancellationSchema.extend({
  applicationId: identifier, confirmed: z.literal(true),
}).strict()

/** Public execution receipts deliberately omit credentials, qualification files and raw source history. */
export const experimentExecutionStatusSchema = z.object({
  version: z.literal(1), generatedAt: experimentInstantSchema, scope: z.record(z.string(), z.unknown()),
  planId: identifier, planStatus: z.enum(['planned', 'stopped']), controllerRunning: z.boolean(),
  state: z.enum(['not_admitted', 'admitted', 'revoked', 'ended']),
  review: z.object({ id: identifier, planHash: experimentHashSchema, createdAt: experimentInstantSchema,
    expiresAt: experimentInstantSchema, sides }).strict().nullable(),
  admission: z.object({ id: identifier, admittedAt: experimentInstantSchema, endsAt: experimentInstantSchema,
    revokedAt: experimentInstantSchema.nullable(), reason: z.string().max(1000).nullable(), sides }).strict().nullable(),
  applications: z.array(z.object({ id: identifier, side, requestedTargetF: z.number().int().min(55).max(110),
    attemptedAt: experimentInstantSchema, outcome: z.enum(['attempting', 'acknowledged', 'unknown', 'resolved']),
    acknowledgment: z.enum(['accepted_not_physically_verified', 'unconfirmed']), finishedAt: experimentInstantSchema.nullable(),
    resolution: z.object({ observedAt: experimentInstantSchema, resolvedAt: experimentInstantSchema,
      targetF: z.number().min(55).max(110) }).strict().nullable() }).strict()).max(2),
}).strict()
export type ExperimentExecutionStatus = z.infer<typeof experimentExecutionStatusSchema>
