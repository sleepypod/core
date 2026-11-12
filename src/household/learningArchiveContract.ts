import { z } from 'zod'
import { householdIdSchema, householdSideSchema } from './contract'

export const learningArchiveLimits = { recordBytes: 8 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, records: 100_000 } as const
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const instant = z.number().int().positive().max(8_640_000_000_000_000)
export const learningArchiveBindingSchema = z.object({
  version: z.literal(1), operationId: householdIdSchema, householdId: householdIdSchema,
  accountId: householdIdSchema, sleeperId: householdIdSchema, datasetId: householdIdSchema, epochId: householdIdSchema,
  capturedAt: instant, soloStartsAt: z.number().int().nonnegative().max(8_640_000_000_000_000), sourceSide: householdSideSchema, timeZone: z.string().min(1).max(100),
  sourceBindingHash: digest, soloEpochHash: digest,
  attribution: z.literal('operator_custody_unreviewed'), activation: z.literal('historical_only'),
}).strict()
export type LearningArchiveBinding = z.infer<typeof learningArchiveBindingSchema>

export const learningArchiveSources = [
  { table: 'comfort_states', key: ['side'], kind: 'personal' },
  { table: 'comfort_feedback', key: ['id'], kind: 'personal' },
  { table: 'journal_entries', key: ['side', 'local_date'], kind: 'personal' },
  { table: 'comfort_moments', key: ['id'], kind: 'personal' },
  { table: 'comfort_models', key: ['id'], kind: 'personal' },
  { table: 'comfort_reviews', key: ['id'], kind: 'personal' },
  { table: 'comfort_events', key: ['id'], kind: 'personal' },
  { table: 'thermal_forecasts', key: ['id'], kind: 'physical' },
  { table: 'target_response_models', key: ['id'], kind: 'physical' },
  { table: 'predictive_recordings', key: ['id'], kind: 'physical' },
  { table: 'side_stage_models', key: ['side'], kind: 'processing' },
  { table: 'stage_model_library', key: ['id'], kind: 'processing' },
  { table: 'stage_classifier_changes', key: ['id'], kind: 'processing' },
  { table: 'biometric_profile_revisions', key: ['id'], kind: 'processing' },
  { table: 'biometric_profile_bindings', key: ['side'], kind: 'processing' },
] as const

export const learningArchiveRecordSchema = z.object({
  id: householdIdSchema, operation_id: householdIdSchema, ordinal: z.number().int().positive().max(learningArchiveLimits.records),
  source_table: z.enum(learningArchiveSources.map(source => source.table)), source_key: z.string().min(1).max(4096),
  source_side: householdSideSchema, kind: z.enum(['personal', 'physical', 'processing']), payload: z.string().nullable(),
  payload_bytes: z.number().int().nonnegative().max(learningArchiveLimits.recordBytes),
  payload_hash: digest, record_hash: digest, redaction: z.string().max(4096).nullable(),
}).strict()
export type LearningArchiveRecord = z.infer<typeof learningArchiveRecordSchema>
