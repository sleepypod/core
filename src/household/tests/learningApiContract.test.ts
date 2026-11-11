import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { learningArchivePageSchema, learningRecordDetailSchema, learningRecordPageSchema, parseLearningSearch } from '../learningApiContract'

const archiveId = randomUUID(), recordId = randomUUID(), capturedAt = Date.parse('2026-11-11T10:00:00Z')
const envelope = { version: 1, generatedAt: capturedAt, scope: { podId: randomUUID(), householdId: randomUUID(),
  accountId: randomUUID(), sleeperId: randomUUID(), sessionRevision: 2, householdRevision: 2, assignmentRevision: 2 },
interpretation: 'historical_custody_not_training_approval' }
const archive = { archiveId, capturedAt, sourceSide: 'left', timeZone: 'America/Los_Angeles', recordCount: 2,
  payloadBytes: 200, contentHash: 'a'.repeat(64), attribution: 'operator_custody_unreviewed', activation: 'historical_only' }
const archivePage = { ...envelope, query: { before: null, limit: 1 }, archives: [archive], nextCursor: archiveId }
const record = { recordId, ordinal: 1, sourceTable: 'comfort_states', sourceSide: 'left', kind: 'personal', payloadBytes: 100, redacted: false }
const recordPage = { ...envelope, query: { archiveId, after: 0, limit: 1 }, archiveId, contentHash: 'a'.repeat(64), records: [record], nextOrdinal: 1 }
const detail = { ...envelope, recordId, archiveId, sourceTable: 'comfort_states', sourceSide: 'left', kind: 'personal',
  attribution: 'operator_custody_unreviewed', activation: 'historical_only', payloadHash: 'b'.repeat(64),
  encoding: 'sqlite_row_json_text', payload: '{"id":9007199254740993}', redacted: false }

describe('private preserved-learning transport', () => {
  it('keeps provenance, exact original JSON and bounded cursors distinct from training approval', () => {
    expect(learningArchivePageSchema.parse(archivePage)).toEqual(archivePage)
    expect(learningRecordPageSchema.parse(recordPage)).toEqual(recordPage)
    expect(learningRecordDetailSchema.parse(detail)).toEqual(detail)
    expect(learningRecordDetailSchema.parse({ ...detail, payload: null, redacted: true }).payload).toBeNull()
    expect(parseLearningSearch(new URLSearchParams(), false)).toEqual({ before: null, limit: 20 })
    expect(parseLearningSearch(new URLSearchParams({ archiveId }), true)).toEqual({ archiveId, after: 0, limit: 20 })
  })

  it.each(['0', '51', '-1', '01', '1.5', '1e1', 'Infinity', 'NaN', '', '99999999999999999'])('rejects page limit %s', (limit) => {
    for (const records of [true, false]) {
      const query = new URLSearchParams({ limit })
      if (records) query.set('archiveId', archiveId)
      expect(() => parseLearningSearch(query, records)).toThrow()
    }
  })

  it.each(['__proto__=x', 'constructor=x', 'side=left', 'accountId=x', 'limit=1&limit=2', 'before=bad-id'])('rejects unexpected or ambiguous selectors %s', (query) => {
    expect(() => parseLearningSearch(new URLSearchParams(query), false)).toThrow()
  })

  it('rejects archive metadata with impossible times, duplicate entries or a misleading next page', () => {
    expect(() => learningArchivePageSchema.parse({ ...archivePage, archives: [archive, archive] })).toThrow()
    expect(() => learningArchivePageSchema.parse({ ...archivePage, nextCursor: randomUUID() })).toThrow()
    expect(() => learningArchivePageSchema.parse({ ...archivePage, archives: [{ ...archive, capturedAt: capturedAt + 1 }] })).toThrow()
    expect(() => learningArchivePageSchema.parse({ ...archivePage, query: { ...archivePage.query, limit: 2 } })).toThrow()
  })

  it('rejects wrong archives, nonadvancing cursors, duplicate records and mislabeled provenance', () => {
    expect(() => learningRecordPageSchema.parse({ ...recordPage, archiveId: randomUUID() })).toThrow()
    expect(() => learningRecordPageSchema.parse({ ...recordPage, nextOrdinal: 2 })).toThrow()
    expect(() => learningRecordPageSchema.parse({ ...recordPage, query: { ...recordPage.query, after: 1 } })).toThrow()
    expect(() => learningRecordPageSchema.parse({ ...recordPage, records: [record, { ...record, ordinal: 2 }] })).toThrow()
    expect(() => learningRecordPageSchema.parse({ ...recordPage, records: [{ ...record, kind: 'physical' }] })).toThrow()
  })

  it('rejects fabricated activation, mismatched redaction, credentials and unknown detail fields', () => {
    for (const changes of [{ activation: 'active' }, { attribution: 'confirmed_personal' }, { payload: null },
      { redacted: true }, { sourceTable: 'household_devices' }, { deviceSecret: 'never-export' }, { kind: 'physical' }])
      expect(() => learningRecordDetailSchema.parse({ ...detail, ...changes })).toThrow()
  })
})
