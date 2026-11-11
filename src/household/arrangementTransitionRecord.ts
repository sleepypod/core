import type Database from 'better-sqlite3'
import { z } from 'zod'
import { controllerGenerationSchema } from '@/src/server/controllerGeneration'
import { householdIdSchema, revisionSchema } from './contract'
import { HouseholdError } from './store'
import { arrangementTransitionRequestSchema } from './arrangementTransitionContract'
import { arrangementDigest } from './arrangementTransitionState'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const rejectArrangementTransition = () => new HouseholdError('conflict', 409,
  'The arrangement transition needs a fresh review or recovery. Hardware changes remain paused if a hold was already saved.')
export const arrangementHistoryContextSchema = z.object({
  datasetId: householdIdSchema, attributionRevision: revisionSchema, epochId: householdIdSchema,
  startsAt: z.number().int().nonnegative().max(8_640_000_000_000_000), epochHash: digest, bindingHash: digest,
}).strict()
export const arrangementTransitionContextSchema = z.object({
  policy: digest, history: arrangementHistoryContextSchema, controller: controllerGenerationSchema,
}).strict()
const rowSchema = z.object({
  id: householdIdSchema, household_id: householdIdSchema, review_id: householdIdSchema,
  account_id: householdIdSchema, device_id: householdIdSchema, run_id: householdIdSchema,
  request_hash: digest, request: z.string().max(8192), admission_revision: revisionSchema,
  state: z.enum(['held', 'committed', 'cancelled']), created_at: instant, committed_at: instant.nullable(), context: z.string().max(8192),
  archive: z.string().max(4 * 1024 * 1024).nullable(), committed_hash: digest.nullable(),
  processing: z.string().max(8192).nullable(), recovery: z.string().max(16384).nullable(),
  cancellation: z.string().max(16384).nullable(),
}).strict().refine(row => row.state === 'committed'
  ? row.committed_at !== null && row.committed_at >= row.created_at && row.archive !== null
  && row.committed_hash !== null && row.processing !== null && row.cancellation === null
  : row.committed_at === null && row.archive === null && row.committed_hash === null && row.processing === null && row.recovery === null
    && (row.state === 'cancelled' ? row.cancellation !== null : row.cancellation === null))
export type ArrangementTransitionRow = z.infer<typeof rowSchema>

/** One strict reader serves initial commit and recovery; neither path repairs an invalid receipt. */
export function readArrangementTransition(database: Database.Database, operationId: string) {
  householdIdSchema.parse(operationId)
  const raw = database.prepare('SELECT * FROM household_arrangement_transitions WHERE id = ?').get(operationId)
  if (!raw) return undefined
  const row = rowSchema.parse(raw)
  const request = arrangementTransitionRequestSchema.parse(JSON.parse(row.request))
  if (request.requestId !== row.id || request.reviewId !== row.review_id || arrangementDigest(request) !== row.request_hash)
    throw rejectArrangementTransition()
  const context = arrangementTransitionContextSchema.parse(JSON.parse(row.context))
  if (context.controller.observedAt > row.created_at || row.created_at - context.controller.observedAt > 5000)
    throw rejectArrangementTransition()
  return row
}
