import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { comfortEvent } from '@/src/comfort/event'
import { JournalError, journalRecordSchema, journalSelectionSchema, journalWriteSchema, type JournalRecord, type JournalSelection, type JournalWrite } from './contract'

interface JournalRow { revision: string, record: string | null }
function selection(side: Side, date: string, row?: JournalRow): JournalSelection {
  const result = journalSelectionSchema.parse({ side, date, revision: row?.revision ?? null,
    record: row?.record ? journalRecordSchema.parse(JSON.parse(row.record)) : null })
  if (result.record && (result.record.side !== side || result.record.date !== date)) throw new Error('Journal identity mismatch')
  return result
}

/** Journal and learning feedback share one SQLite transaction. Notes never enter comfort events. */
export function createJournalStore(database: Database.Database) {
  const read = (side: Side, date: string) => selection(side, date,
    database.prepare('SELECT revision,record FROM journal_entries WHERE side=? AND local_date=?').get(side, date) as JournalRow | undefined)
  return {
    read,
    list(side: Side, from: string, through: string): JournalSelection[] {
      const rows = database.prepare(`SELECT local_date,revision,record FROM journal_entries
        WHERE side=? AND local_date>=? AND local_date<=? AND record IS NOT NULL ORDER BY local_date DESC LIMIT 90`)
        .all(side, from, through) as Array<JournalRow & { local_date: string }>
      return rows.map(row => selection(side, row.local_date, row))
    },
    write(request: JournalWrite, timeZone: string, now: number): JournalSelection {
      const input = journalWriteSchema.parse(request)
      return database.transaction(() => {
        const current = read(input.side, input.date)
        if (current.revision !== input.expectedRevision) throw new JournalError('This check-in changed on another device. Your draft is still here; reload the saved entry before replacing it.', 'CONFLICT')
        const record: JournalRecord | null = input.fields
          ? journalRecordSchema.parse({
              side: input.side, date: input.date, fields: input.fields,
              timeZone: current.record?.timeZone ?? timeZone, origin: current.record?.origin ?? 'sleepypod',
              createdAt: current.record ? current.record.createdAt : now, importedAt: current.record?.importedAt ?? null, updatedAt: now,
            })
          : null
        const revision = randomUUID()
        database.prepare(`INSERT INTO journal_entries(side,local_date,revision,record) VALUES (?,?,?,?)
          ON CONFLICT(side,local_date) DO UPDATE SET revision=excluded.revision,record=excluded.record`)
          .run(input.side, input.date, revision, record ? JSON.stringify(record) : null)
        if (record) database.prepare(`INSERT INTO comfort_feedback(side,local_date,comfort,recorded_at) VALUES (?,?,?,?)
          ON CONFLICT(side,local_date) DO UPDATE SET comfort=excluded.comfort,recorded_at=excluded.recorded_at`)
          .run(input.side, input.date, record.fields.comfort, now)
        else database.prepare('DELETE FROM comfort_feedback WHERE side=? AND local_date=?').run(input.side, input.date)
        const event = comfortEvent(now, 'feedback', record ? `${input.date}: ${record.fields.comfort}.` : `${input.date}: check-in removed.`)
        database.prepare('INSERT INTO comfort_events(side,observed_at,event) VALUES (?,?,?)').run(input.side, now, JSON.stringify(event))
        return { side: input.side, date: input.date, revision, record }
      }).immediate()
    },
  }
}

/** Older comfort-only clients edit just that field and invalidate any full-journal draft. Caller owns the transaction. */
export function synchronizeJournalComfort(database: Database.Database, side: Side, date: string, comfort: JournalRecord['fields']['comfort'], now: number): void {
  const current = createJournalStore(database).read(side, date)
  if (!current.record || current.record.fields.comfort === comfort) return
  const record = journalRecordSchema.parse({ ...current.record, fields: { ...current.record.fields, comfort }, updatedAt: now })
  database.prepare('UPDATE journal_entries SET revision=?,record=? WHERE side=? AND local_date=?')
    .run(randomUUID(), JSON.stringify(record), side, date)
}
