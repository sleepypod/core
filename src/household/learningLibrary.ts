import type Database from 'better-sqlite3'
import { z } from 'zod'
import { householdIdSchema } from './contract'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { readLearningArchive, verifiedLearningRecord } from './learningArchive'
import { learningArchiveRecordSchema } from './learningArchiveContract'
import { learningAfterSchema, learningPageLimitSchema } from './learningApiContract'

const unavailable = () => new HouseholdError('not_ready', 404, 'This private learning record is unavailable.')

/** Original custody, never current side, determines access. Archives cannot be offered to a trainer or actuator here. */
export class PersonalLearningLibrary {
  constructor(private readonly database: Database.Database, private readonly identities: HouseholdStore) {}

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
      payload IS NULL AS redacted FROM household_learning_records WHERE operation_id = ?
      AND ordinal > ? ORDER BY ordinal LIMIT ?`).all(archiveId, after, limit + 1)
    const records = rows.slice(0, limit).map((raw) => {
      const { redacted, ...metadata } = raw as Record<string, unknown>
      const row = learningArchiveRecordSchema.pick({ id: true, ordinal: true, source_table: true,
        source_side: true, kind: true, payload_bytes: true }).parse(metadata)
      return { recordId: row.id, ordinal: row.ordinal, sourceTable: row.source_table, sourceSide: row.source_side,
        kind: row.kind, payloadBytes: row.payload_bytes, redacted: z.union([z.literal(0), z.literal(1)]).parse(redacted) === 1 }
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
