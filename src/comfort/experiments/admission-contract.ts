import { z } from 'zod'
import { ownerSnapshotSchema } from '../owner-contract'
import { experimentHashSchema, experimentInstantSchema } from './contract'
import { experimentPrincipalSchema } from './execution-principal'

export const EXECUTION_REVIEW_MS = 60_000
export const experimentZoneProofSchema = z.object({ side: z.enum(['left', 'right']), evidence: ownerSnapshotSchema,
  interruptionHash: experimentHashSchema }).strict()
export type ExperimentZoneProof = z.infer<typeof experimentZoneProofSchema>
export const experimentExecutionReviewSchema = z.object({
  id: z.string().uuid(), subjectKey: experimentHashSchema, scopeHash: experimentHashSchema,
  planId: z.string().uuid(), planHash: experimentHashSchema, expectedRevision: z.string().uuid(),
  createdAt: experimentInstantSchema, expiresAt: experimentInstantSchema,
  principal: experimentPrincipalSchema,
  zones: z.array(experimentZoneProofSchema).min(1).max(2),
}).strict().refine(value => value.expiresAt === value.createdAt + EXECUTION_REVIEW_MS
  && new Set(value.zones.map(zone => zone.side)).size === value.zones.length)
export type ExperimentExecutionReview = z.infer<typeof experimentExecutionReviewSchema>
export const experimentGrantSchema = z.object({
  review: experimentExecutionReviewSchema, admittedAt: experimentInstantSchema,
  endsAt: experimentInstantSchema, revokedAt: experimentInstantSchema.nullable(), reason: z.string().max(1000).nullable(),
}).strict().refine(value => value.admittedAt >= value.review.createdAt && value.admittedAt < value.review.expiresAt
  && value.endsAt > value.admittedAt && ((value.revokedAt === null) === (value.reason === null))
  && (value.revokedAt === null || value.revokedAt >= value.admittedAt))
export type ExperimentGrant = z.infer<typeof experimentGrantSchema>
