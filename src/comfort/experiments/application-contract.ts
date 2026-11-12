import { z } from 'zod'
import { experimentDateSchema, experimentHashSchema, experimentInstantSchema } from './contract'

export const EXPERIMENT_POLICY = 'comfort-experiment'
export const EXPERIMENT_LEASE_MS = 10_000
const temperature = z.number().int().min(55).max(110)

/** A grant is separate from saving a plan; only reviewed activation may supply one. */
export const experimentAdmissionSchema = z.object({
  revision: z.string().uuid(), planHash: experimentHashSchema,
  issuedAt: experimentInstantSchema, expiresAt: experimentInstantSchema,
  sides: z.array(z.enum(['left', 'right'])).min(1).max(2),
}).strict().refine(value => value.expiresAt > value.issuedAt && new Set(value.sides).size === value.sides.length)
export type ExperimentAdmission = z.infer<typeof experimentAdmissionSchema>

export const experimentReservationSchema = z.object({
  id: z.string().uuid(), planId: z.string().uuid(), planHash: experimentHashSchema,
  admissionRevision: z.string().uuid(), side: z.enum(['left', 'right']),
  nightDate: experimentDateSchema, requestId: z.string().min(1).max(200),
  targetF: temperature, previousF: z.number().min(55).max(110), reservedAt: experimentInstantSchema,
}).strict()
export type ExperimentApplicationReservation = z.infer<typeof experimentReservationSchema>

export const experimentApplicationSchema = z.object({
  reservation: experimentReservationSchema,
  outcome: z.enum(['attempting', 'acknowledged', 'unknown', 'resolved']),
  receiptId: z.string().uuid().nullable(), finishedAt: experimentInstantSchema.nullable(),
  resolution: z.object({ observedAt: experimentInstantSchema, resolvedAt: experimentInstantSchema,
    targetF: z.number().min(55).max(110) }).strict().nullable(),
}).strict().refine(value => (value.finishedAt === null || value.finishedAt >= value.reservation.reservedAt)
  && (value.outcome !== 'acknowledged' || (value.finishedAt !== null && value.receiptId !== null))
  && ((value.outcome === 'resolved') === (value.resolution !== null))
  && (!value.resolution || (value.resolution.observedAt >= value.reservation.reservedAt
    && value.resolution.resolvedAt >= value.resolution.observedAt)))
export type ExperimentApplication = z.infer<typeof experimentApplicationSchema>
