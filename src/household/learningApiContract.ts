import { z } from 'zod'
import { householdIdSchema } from './contract'
import { personalHistoryScopeSchema } from './historyApiContract'
import { learningArchiveBindingSchema, learningArchiveLimits, learningArchiveRecordSchema, learningArchiveSources } from './learningArchiveContract'

export const learningPageLimitSchema = z.number().int().min(1).max(50)
export const learningAfterSchema = z.number().int().nonnegative().max(learningArchiveLimits.records)
const archiveFields = learningArchiveBindingSchema.shape
const recordFields = learningArchiveRecordSchema.shape
const envelope = {
  version: z.literal(1), generatedAt: archiveFields.capturedAt, scope: personalHistoryScopeSchema,
  interpretation: z.literal('historical_custody_not_training_approval'),
}
const archiveSummary = z.object({
  archiveId: householdIdSchema, capturedAt: archiveFields.capturedAt, sourceSide: archiveFields.sourceSide,
  timeZone: archiveFields.timeZone, recordCount: learningAfterSchema,
  payloadBytes: z.number().int().nonnegative().max(learningArchiveLimits.totalBytes), contentHash: recordFields.payload_hash,
  attribution: archiveFields.attribution, activation: archiveFields.activation,
}).strict()
export const learningArchivePageSchema = z.object({
  ...envelope, query: z.object({ before: householdIdSchema.nullable(), limit: learningPageLimitSchema }).strict(),
  archives: z.array(archiveSummary).max(50), nextCursor: householdIdSchema.nullable(),
}).strict().superRefine((value, context) => {
  if (value.archives.length > value.query.limit || new Set(value.archives.map(archive => archive.archiveId)).size !== value.archives.length
    || value.archives.some(archive => archive.capturedAt > value.generatedAt)
    || (value.nextCursor !== null && (value.archives.length !== value.query.limit || value.nextCursor !== value.archives.at(-1)?.archiveId)))
    context.addIssue({ code: 'custom', message: 'Archive page does not match its query.' })
})
export const learningRecordSummarySchema = z.object({
  recordId: householdIdSchema, ordinal: recordFields.ordinal, sourceTable: recordFields.source_table,
  sourceSide: recordFields.source_side, kind: recordFields.kind, payloadBytes: recordFields.payload_bytes, redacted: z.boolean(),
}).strict().refine(value => learningArchiveSources.find(source => source.table === value.sourceTable)?.kind === value.kind,
  'Learning source and provenance kind do not match.')
export const learningRecordPageSchema = z.object({
  ...envelope, query: z.object({ archiveId: householdIdSchema, after: learningAfterSchema, limit: learningPageLimitSchema }).strict(),
  archiveId: householdIdSchema, contentHash: recordFields.payload_hash,
  records: z.array(learningRecordSummarySchema).max(50), nextOrdinal: recordFields.ordinal.nullable(),
}).strict().superRefine((value, context) => {
  if (value.archiveId !== value.query.archiveId || value.records.length > value.query.limit
    || new Set(value.records.map(record => record.recordId)).size !== value.records.length
    || value.records.some((record, index) => record.ordinal <= (index === 0 ? value.query.after : value.records[index - 1].ordinal))
    || (value.nextOrdinal !== null && (value.records.length !== value.query.limit || value.nextOrdinal !== value.records.at(-1)?.ordinal)))
    context.addIssue({ code: 'custom', message: 'Learning page does not match its archive or cursor.' })
})
export const learningRecordDetailSchema = z.object({
  ...envelope, recordId: householdIdSchema, archiveId: householdIdSchema,
  sourceTable: recordFields.source_table, sourceSide: recordFields.source_side, kind: recordFields.kind,
  attribution: archiveFields.attribution, activation: archiveFields.activation, payloadHash: recordFields.payload_hash,
  encoding: z.literal('sqlite_row_json_text'), payload: z.string().max(learningArchiveLimits.recordBytes).nullable(), redacted: z.boolean(),
}).strict().refine(value => value.redacted === (value.payload === null)
  && learningArchiveSources.find(source => source.table === value.sourceTable)?.kind === value.kind,
'Learning detail has inconsistent provenance or redaction.')

export type LearningArchivePage = z.infer<typeof learningArchivePageSchema>
export type LearningRecordPage = z.infer<typeof learningRecordPageSchema>
export type LearningRecordDetail = z.infer<typeof learningRecordDetailSchema>

/** Reject duplicate selectors, numeric coercion and fields that could imply another account's scope. */
export function parseLearningSearch(search: URLSearchParams, records: boolean) {
  const input: Record<string, unknown> = {}
  for (const [key, value] of search) {
    if (!(records ? ['archiveId', 'after', 'limit'] : ['before', 'limit']).includes(key)) throw new Error('Unsupported learning query field')
    if (Object.hasOwn(input, key)) throw new Error('Duplicate learning query field')
    if (key === 'after' || key === 'limit') {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('Invalid learning query number')
      input[key] = Number(value)
    }
    else input[key] = value
  }
  return records
    ? z.object({ archiveId: householdIdSchema, after: learningAfterSchema.default(0), limit: learningPageLimitSchema.default(20) }).strict().parse(input)
    : z.object({ before: householdIdSchema.nullable().default(null), limit: learningPageLimitSchema.default(20) }).strict().parse(input)
}
