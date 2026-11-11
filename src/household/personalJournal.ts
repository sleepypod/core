import { createHash, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { HouseholdError, type HouseholdCredential, type HouseholdStore } from './store'
import { householdIdSchema, type HouseholdSession } from './contract'
import { personalJournalReceiptSchema, personalJournalSelectionSchema, personalJournalTimeZoneSchema,
  personalJournalWriteSchema, parsePersonalJournalQuery, type PersonalJournalSelection } from './personalJournalContract'
import { journalDateSchema } from '@/src/journal/contract'
import { mergedJournalFields } from '@/src/journal/store'
import { contextTimesAreValid } from '@/src/journal/context'
import { historyDayStart, sourceDate } from '@/src/lib/localDates'

const storedInstant = z.number().int().nonnegative().max(253402300799000)
const journalRowSchema = z.object({
  account_id: householdIdSchema, sleeper_id: householdIdSchema, local_date: journalDateSchema, revision: householdIdSchema,
  time_zone: personalJournalTimeZoneSchema, created_at: storedInstant, updated_at: storedInstant,
  fields: z.string().max(16 * 1024).nullable(),
}).strict().refine(value => value.updated_at >= value.created_at, 'Stored check-in clocks are inconsistent.')
type JournalRow = z.infer<typeof journalRowSchema>
interface MutationRow { account_id: string, kind: string, request_hash: string, result: string }
const conflict = (message: string) => new HouseholdError('conflict', 409, message)
const unavailable = () => new HouseholdError('not_ready', 503, 'The saved check-in needs review before it can be used.')
const kind = 'personal_journal'

/** This store never resolves a mattress side, writes legacy feedback or activates learning. */
export class PersonalJournalStore {
  constructor(private readonly database: Database.Database, private readonly identities: HouseholdStore,
    private readonly timeZone: () => string, private readonly now = () => Date.now()) {}

  currentTimeZone() { return personalJournalTimeZoneSchema.parse(this.timeZone()) }

  private row(session: HouseholdSession, date: string) {
    const value = this.database.prepare('SELECT * FROM household_journal_entries WHERE account_id = ? AND local_date = ?')
      .get(session.accountId, date)
    try {
      return value ? journalRowSchema.parse(value) : undefined
    }
    catch { throw unavailable() }
  }

  private selection(session: HouseholdSession, date: string, row?: JournalRow): PersonalJournalSelection {
    if (row && (row.account_id !== session.accountId || row.sleeper_id !== session.selfSleeperId || row.local_date !== date))
      throw new HouseholdError('not_ready', 503, 'The saved check-in identity needs review.')
    try {
      return personalJournalSelectionSchema.parse({ date, revision: row?.revision ?? null, timeZone: row?.time_zone ?? null,
        record: row?.fields === null || !row
          ? null
          : { date, timeZone: row.time_zone, createdAt: row.created_at,
              updatedAt: row.updated_at, fields: JSON.parse(row.fields) } })
    }
    catch { throw unavailable() }
  }

  read(credential: HouseholdCredential, date: string) {
    journalDateSchema.parse(date)
    const session = this.identities.session(credential)
    return this.selection(session, date, this.row(session, date))
  }

  list(credential: HouseholdCredential, from: string, through: string) {
    parsePersonalJournalQuery(new URLSearchParams({ from, through }))
    const session = this.identities.session(credential)
    const rows = this.database.prepare(`SELECT * FROM household_journal_entries
      WHERE account_id = ? AND local_date >= ? AND local_date <= ? AND fields IS NOT NULL ORDER BY local_date DESC LIMIT 90`)
      .all(session.accountId, from, through) as JournalRow[]
    return rows.map(row => this.selection(session, row.local_date, journalRowSchema.parse(row)))
  }

  receipt(credential: HouseholdCredential, requestId: string) {
    householdIdSchema.parse(requestId)
    const session = this.identities.session(credential)
    const row = this.database.prepare('SELECT result FROM household_mutation_receipts WHERE request_id = ? AND account_id = ? AND kind = ?')
      .get(requestId, session.accountId, kind) as { result: string } | undefined
    const receipt = row ? personalJournalReceiptSchema.parse(JSON.parse(row.result)) : null
    if (receipt && receipt.requestId !== requestId) throw new HouseholdError('not_ready', 503, 'The saved check-in receipt needs review.')
    return receipt
  }

  /** CAS and metadata-only receipts commit together. Replaying an older save cannot recreate deleted content. */
  write(credential: HouseholdCredential, input: unknown) {
    const request = personalJournalWriteSchema.parse(input)
    return this.database.transaction(() => {
      const session = this.identities.session(credential)
      if (session.sessionRevision !== request.expectedSessionRevision || session.assignmentRevision !== request.expectedAssignmentRevision)
        throw conflict('Your account or bed assignment changed. Reload before saving this check-in.')
      const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
      const previous = this.database.prepare('SELECT * FROM household_mutation_receipts WHERE request_id = ?').get(request.requestId) as MutationRow | undefined
      if (previous) {
        if (previous.account_id !== session.accountId || previous.kind !== kind || previous.request_hash !== hash)
          throw conflict('This request identifier was already used.')
        const receipt = this.receipt(credential, request.requestId)
        if (!receipt) throw unavailable()
        return receipt
      }
      const current = this.read(credential, request.date)
      const stored = this.row(session, request.date)
      if (current.revision !== request.expectedRevision) throw conflict('This check-in changed on another device. Reload it before saving.')
      const timeZone = current.timeZone ?? this.currentTimeZone()
      if (request.expectedTimeZone !== timeZone) throw conflict('The check-in time zone changed. Reload and review its times.')
      const now = this.now()
      if (!Number.isSafeInteger(now) || now < 0 || now < (stored?.updated_at ?? 0)) throw conflict('The controller clock needs review before saving.')
      if (request.date > sourceDate(now / 1000, timeZone)) throw conflict('A check-in cannot describe a future date.')
      try {
        historyDayStart(request.date, timeZone)
      }
      catch { throw conflict('This calendar date does not occur in the check-in time zone.') }
      const fields = request.fields ? mergedJournalFields(request.fields, current.record?.fields) : null
      if (fields?.context && !contextTimesAreValid(fields.context, request.date, timeZone, now))
        throw conflict('Habit times must fall in the preceding day or wake date and cannot be in the future.')
      const revision = randomUUID()
      this.database.prepare(`INSERT INTO household_journal_entries
        (account_id, sleeper_id, local_date, revision, time_zone, created_at, updated_at, fields) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, local_date) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at, fields = excluded.fields`)
        .run(session.accountId, session.selfSleeperId, request.date, revision, timeZone, now, now, fields ? JSON.stringify(fields) : null)
      const receipt = personalJournalReceiptSchema.parse({ requestId: request.requestId, date: request.date, revision, timeZone,
        savedAt: now, outcome: fields ? 'saved' : 'deleted' })
      this.database.prepare('INSERT INTO household_mutation_receipts (request_id, account_id, kind, request_hash, result, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(request.requestId, session.accountId, kind, hash, JSON.stringify(receipt), now)
      return receipt
    }).immediate()
  }
}
