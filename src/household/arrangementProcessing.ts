import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/schema'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { defaultConfig } from '@/src/biometrics/algorithms/registry'
import { ProfileStore } from '@/src/biometrics/profiles/store'
import { requestManualActivation } from '@/src/biometrics/profiles/activation'
import { stageClassifierSchema } from '@/src/lib/sleep-stage-rules'
import { householdIdSchema, revisionSchema } from './contract'
import type { ApprovedArrangementSnapshot } from './arrangementReviews'
import { readBiometricHistoryIdentity } from './historySource'

const instant = z.number().int().positive().max(8_640_000_000_000_000)
const profile = z.object({ generation: revisionSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
export const arrangementProcessingSchema = z.object({
  version: z.literal(1), operationId: householdIdSchema, householdId: householdIdSchema,
  datasetId: householdIdSchema, assignmentRevision: revisionSchema, committedAt: instant,
  mode: z.literal('two'), profiles: z.object({ left: profile, right: profile }).strict(),
}).strict()
export type ArrangementProcessing = z.infer<typeof arrangementProcessingSchema>

/** Called inside the arrangement commit. Keep old personal revisions; give both new zones fresh defaults. */
export function prepareArrangementProcessing(database: Database.Database, plan: Pick<ApprovedArrangementSnapshot, 'householdId' | 'assignmentRevision'>,
  operationId: string, datasetId: string, now: number): ArrangementProcessing {
  if (!database.inTransaction) throw new Error('Processing changes must share the arrangement transaction')
  const store = drizzle(database, { schema })
  const profiles = new ProfileStore(store, () => now)
  const next = (side: 'left' | 'right') => {
    const legacy = database.prepare('SELECT stage_classifier FROM side_settings WHERE side = ?').get(side) as { stage_classifier: string | null } | undefined
    if (legacy?.stage_classifier !== null && legacy?.stage_classifier !== undefined) {
      const parsed = stageClassifierSchema.safeParse(JSON.parse(legacy.stage_classifier))
      if (parsed.success) profiles.migrateLegacy(side)
      // An invalid old classifier is preserved by the explicit reset event and the arrangement archive.
    }
    const binding = profiles.binding(side)
    revisionSchema.parse(binding.generation + 1)
    const event = requestManualActivation(store, { side, action: 'reset', revisionId: null,
      expectedGeneration: binding.generation, expectedResolvedHash: configHash(defaultConfig), boundary: 'immediate',
      requester: `household-arrangement:${operationId}`, idempotencyKey: `household-arrangement:${operationId}:${side}`,
      allowUnvalidated: true }, now)
    database.prepare('UPDATE biometric_config_outbox SET state = \'failed\', last_error = \'Superseded by reviewed household arrangement\' WHERE side = ? AND generation < ? AND state = \'pending\'')
      .run(side, event.generation)
    return { generation: event.generation, hash: event.nextHash }
  }
  return arrangementProcessingSchema.parse({ version: 1, operationId, householdId: plan.householdId, datasetId,
    assignmentRevision: plan.assignmentRevision + 1, committedAt: now, mode: 'two', profiles: { left: next('left'), right: next('right') } })
}

const receiptSchema = z.object({
  component: z.enum(['sleep-detector', 'piezo-processor']), process_id: householdIdSchema,
  intent_hash: z.string().regex(/^[a-f0-9]{64}$/), first_sample_ms: instant,
  latest_sample_ms: instant, heartbeat_at_ms: instant,
}).strict()

/** Read-only proof for a later attended release. Old processes, stale heartbeats and changed sources never qualify. */
export function readArrangementProcessing(biometrics: Database.Database, raw: unknown, now = Date.now()) {
  const intent = arrangementProcessingSchema.parse(raw)
  const source = readBiometricHistoryIdentity(biometrics)
  if (source.datasetId !== intent.datasetId || source.createdAt > now || intent.committedAt > now) return null
  const rows = biometrics.prepare(`SELECT component, process_id, intent_hash, first_sample_ms, latest_sample_ms, heartbeat_at_ms
    FROM household_processing_receipts WHERE operation_id = ? ORDER BY component`).all(intent.operationId)
  if (rows.length !== 2) return null
  const parsed = z.array(receiptSchema).safeParse(rows)
  if (!parsed.success) return null
  const evidence = parsed.data
  if (new Set(evidence.map(row => row.component)).size !== 2 || evidence.some(row =>
    row.intent_hash !== configHash(intent) || row.first_sample_ms < intent.committedAt
    || row.latest_sample_ms < row.first_sample_ms || row.latest_sample_ms > row.heartbeat_at_ms
    || row.heartbeat_at_ms > now || now - row.latest_sample_ms > 10_000 || now - row.heartbeat_at_ms > 5_000)) return null
  return { earliestAssignedSampleAt: Math.max(...evidence.map(row => row.first_sample_ms)), receipts: evidence }
}
