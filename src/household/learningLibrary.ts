import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { householdIdSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { readLearningArchive, verifiedLearningRecord } from './learningArchive'
import { learningArchiveRecordSchema } from './learningArchiveContract'
import { learningAfterSchema, learningPageLimitSchema } from './learningApiContract'
import { journalDateSchema } from '@/src/journal/contract'
import { learningRemovalRequestSchema, learningRemovalReceiptSchema } from './learningRemovalContract'

const unavailable = () => new HouseholdError('not_ready', 404, 'This private learning record is unavailable.')
const removalKind = 'learning_archive_removal'
const conflict = (message: string) => new HouseholdError('conflict', 409, message)

/** Original custody, never current side, determines access. Archives cannot be offered to a trainer or actuator here. */
export class PersonalLearningLibrary {
  constructor(private readonly database: Database.Database, private readonly identities: HouseholdStore,
    private readonly now = () => Date.now()) {}

  removalReceipt(credential: HouseholdCredential, requestId: string) {
    householdIdSchema.parse(requestId)
    const owner = this.identities.session(credential)
    const row = this.database.prepare('SELECT result FROM household_mutation_receipts WHERE request_id = ? AND account_id = ? AND kind = ?')
      .get(requestId, owner.accountId, removalKind) as { result: string } | undefined
    if (!row) return null
    const receipt = learningRemovalReceiptSchema.parse(JSON.parse(row.result))
    const record = this.detail(credential, receipt.recordId)
    const saved = this.database.prepare('SELECT redaction FROM household_learning_records WHERE id = ?').get(record.recordId) as { redaction: string | null }
    if (receipt.requestId !== requestId || receipt.archiveId !== record.archiveId || receipt.payloadHash !== record.payloadHash || !record.redacted
      || JSON.parse(saved.redaction ?? 'null')?.deletedAt !== receipt.removedAt)
      throw new HouseholdError('not_ready', 503, 'The removal receipt needs review before it can be displayed.')
    return receipt
  }

  /** Remove only the reviewed archived payload; the custody receipt and original source remain intact. */
  remove(credential: HouseholdCredential, input: unknown) {
    const request = learningRemovalRequestSchema.parse(input)
    return this.database.transaction(() => {
      const owner = this.identities.session(credential)
      if (owner.sessionRevision !== request.expectedSessionRevision || owner.assignmentRevision !== request.expectedAssignmentRevision)
        throw conflict('Your account or bed assignment changed. Reload the archived record before removing its content.')
      const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
      const previous = this.database.prepare('SELECT account_id, kind, request_hash FROM household_mutation_receipts WHERE request_id = ?')
        .get(request.requestId) as { account_id: string, kind: string, request_hash: string } | undefined
      if (previous) {
        if (previous.account_id !== owner.accountId || previous.kind !== removalKind || previous.request_hash !== requestHash)
          throw conflict('This request identifier was already used.')
        const receipt = this.removalReceipt(credential, request.requestId)
        if (!receipt) throw unavailable()
        return receipt
      }
      const record = this.detail(credential, request.recordId)
      if (record.archiveId !== request.archiveId || record.payloadHash !== request.expectedPayloadHash)
        throw conflict('The archived record does not match the copy you reviewed. Reload before removing it.')
      const { binding } = this.ownedArchive(credential, record.archiveId)
      const now = this.now()
      if (!Number.isSafeInteger(now) || now < binding.capturedAt || now > 8_640_000_000_000_000)
        throw conflict('The controller clock needs review before removing archived content.')
      let removedAt = now
      if (record.redacted) {
        const row = this.database.prepare('SELECT redaction FROM household_learning_records WHERE id = ?').get(record.recordId) as { redaction: string }
        removedAt = JSON.parse(row.redaction).deletedAt
        if (removedAt > now) throw conflict('The controller clock precedes this removal receipt.')
      }
      else {
        const redaction = { version: 1, requestId: request.requestId, accountId: owner.accountId,
          recordId: record.recordId, payloadHash: record.payloadHash, deletedAt: now }
        const changed = this.database.prepare('UPDATE household_learning_records SET payload = NULL, redaction = ? WHERE id = ? AND payload_hash = ? AND payload IS NOT NULL')
          .run(JSON.stringify(redaction), record.recordId, record.payloadHash)
        if (changed.changes !== 1) throw conflict('The archived content changed before removal.')
      }
      const receipt = learningRemovalReceiptSchema.parse({ requestId: request.requestId, recordId: record.recordId,
        archiveId: record.archiveId, payloadHash: record.payloadHash, removedAt, outcome: 'content_removed' })
      this.database.prepare('INSERT INTO household_mutation_receipts (request_id, account_id, kind, request_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(request.requestId, owner.accountId, removalKind, requestHash, JSON.stringify(receipt), now)
      return receipt
    }).immediate()
  }

  archives(credential: HouseholdCredential, before: string | null, limit: number) {
    householdIdSchema.nullable().parse(before)
    learningPageLimitSchema.parse(limit)
    const owner = this.identities.session(credential)
    const cursor = before ? this.ownedArchive(credential, before).manifest : null
    const rows = this.database.prepare(`SELECT operation_id FROM household_learning_archives
      WHERE household_id = ? AND account_id = ? AND sleeper_id = ?
      AND (? IS NULL OR captured_at < ? OR (captured_at = ? AND operation_id < ?))
      ORDER BY captured_at DESC, operation_id DESC LIMIT ?`).all(owner.householdId, owner.accountId, owner.selfSleeperId,
      cursor?.captured_at ?? null, cursor?.captured_at ?? null, cursor?.captured_at ?? null, before, limit + 1) as { operation_id: string }[]
    const archives = rows.slice(0, limit).map((row) => {
      const { manifest, binding } = this.ownedArchive(credential, row.operation_id)
      return { archiveId: binding.operationId, capturedAt: binding.capturedAt, sourceSide: binding.sourceSide, timeZone: binding.timeZone,
        recordCount: manifest.record_count, payloadBytes: manifest.payload_bytes, contentHash: manifest.content_hash,
        attribution: binding.attribution, activation: binding.activation }
    })
    return { archives, nextCursor: rows.length > limit ? archives.at(-1)?.archiveId ?? null : null }
  }

  private ownedArchive(credential: HouseholdCredential, archiveId: string) {
    householdIdSchema.parse(archiveId)
    const owner = this.identities.session(credential)
    const row = this.database.prepare(`SELECT operation_id FROM household_learning_archives
      WHERE operation_id = ? AND household_id = ? AND account_id = ? AND sleeper_id = ?`)
      .get(archiveId, owner.householdId, owner.accountId, owner.selfSleeperId)
    if (!row) throw unavailable()
    return readLearningArchive(this.database, archiveId)
  }

  records(credential: HouseholdCredential, archiveId: string, after: number, limit: number) {
    learningAfterSchema.parse(after)
    learningPageLimitSchema.parse(limit)
    const { manifest } = this.ownedArchive(credential, archiveId)
    const rows = this.database.prepare(`SELECT id, ordinal, source_table, source_side, kind, payload_bytes,
      payload IS NULL AS redacted, CASE WHEN source_table = 'journal_entries' THEN json_extract(source_key, '$[1]')
      WHEN source_table = 'comfort_feedback' THEN json_extract(payload, '$.local_date') ELSE NULL END AS recorded_date
      FROM household_learning_records WHERE operation_id = ?
      AND ordinal > ? ORDER BY ordinal LIMIT ?`).all(archiveId, after, limit + 1)
    const records = rows.slice(0, limit).map((raw) => {
      const { redacted, recorded_date, ...metadata } = raw as Record<string, unknown>
      const row = learningArchiveRecordSchema.pick({ id: true, ordinal: true, source_table: true,
        source_side: true, kind: true, payload_bytes: true }).parse(metadata)
      return { recordId: row.id, ordinal: row.ordinal, sourceTable: row.source_table, sourceSide: row.source_side,
        kind: row.kind, payloadBytes: row.payload_bytes, redacted: z.union([z.literal(0), z.literal(1)]).parse(redacted) === 1,
        recordedDate: journalDateSchema.safeParse(recorded_date).data ?? null }
    })
    return { archiveId, contentHash: manifest.content_hash, records,
      nextOrdinal: rows.length > limit ? records.at(-1)?.ordinal ?? null : null }
  }

  detail(credential: HouseholdCredential, recordId: string) {
    householdIdSchema.parse(recordId)
    const owner = this.identities.session(credential)
    const row = this.database.prepare(`SELECT record.* FROM household_learning_records record
      JOIN household_learning_archives archive ON archive.operation_id = record.operation_id
      WHERE record.id = ? AND archive.household_id = ? AND archive.account_id = ? AND archive.sleeper_id = ?`)
      .get(recordId, owner.householdId, owner.accountId, owner.selfSleeperId) as { operation_id: string } | undefined
    if (!row) throw unavailable()
    const { binding } = this.ownedArchive(credential, row.operation_id)
    const record = verifiedLearningRecord(row, binding)
    return { recordId: record.id, archiveId: binding.operationId, sourceTable: record.source_table, sourceSide: record.source_side,
      kind: record.kind, attribution: binding.attribution, activation: binding.activation, payloadHash: record.payload_hash,
      // The exact source JSON stays text, preserving original integer IDs and nested model documents.
      encoding: 'sqlite_row_json_text', payload: record.payload, redacted: record.payload === null }
  }
}
