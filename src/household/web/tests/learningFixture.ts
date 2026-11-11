import type { HouseholdSession } from '../../contract'
import { learningArchivePageSchema, learningRecordPageSchema, learningRecordDetailSchema } from '../../learningApiContract'

/** Synthetic library examples for tests and visual review, never imported into a Pod. */
export function learningFixture(session: HouseholdSession) {
  const archiveId = '30000000-0000-4000-8000-000000000001'
  const recordId = '30000000-0000-4000-8000-000000000002'
  const scope = { podId: session.podId, householdId: session.householdId, accountId: session.accountId,
    sleeperId: session.selfSleeperId, sessionRevision: session.sessionRevision,
    assignmentRevision: session.assignmentRevision, householdRevision: session.householdRevision }
  const capturedAt = Date.UTC(2026, 10, 11, 8)
  const envelope = { version: 1, generatedAt: capturedAt + 1000, scope, interpretation: 'historical_custody_not_training_approval' }
  const archives = learningArchivePageSchema.parse({ ...envelope, query: { before: null, limit: 20 }, archives: [{
    archiveId, capturedAt, sourceSide: 'left', timeZone: 'America/Los_Angeles', recordCount: 1, payloadBytes: 600,
    contentHash: 'a'.repeat(64), attribution: 'operator_custody_unreviewed', activation: 'historical_only',
  }], nextCursor: null })
  const records = learningRecordPageSchema.parse({ ...envelope, query: { archiveId, after: 0, limit: 20 }, archiveId,
    contentHash: 'a'.repeat(64), records: [{ recordId, ordinal: 1, sourceTable: 'journal_entries', sourceSide: 'left',
      kind: 'personal', payloadBytes: 600, redacted: false, recordedDate: '2026-10-30' }], nextOrdinal: null })
  const journal = { side: 'left', date: '2026-10-30', timeZone: 'America/Los_Angeles', origin: 'sleepypod',
    createdAt: null, updatedAt: null, importedAt: null,
    fields: { restfulness: 4, comfort: 'comfortable', caffeine: false, alcohol: false, exercise: true,
      notes: 'Felt comfortable after an earlier bedtime.' } }
  const detail = learningRecordDetailSchema.parse({ ...envelope, archiveId, recordId, sourceTable: 'journal_entries', sourceSide: 'left',
    kind: 'personal', attribution: 'operator_custody_unreviewed', activation: 'historical_only', payloadHash: 'b'.repeat(64),
    encoding: 'sqlite_row_json_text', payload: JSON.stringify({ side: 'left', local_date: '2026-10-30', revision: recordId, record: JSON.stringify(journal) }), redacted: false })
  return { archiveId, recordId, archives, records, detail }
}
