import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { HouseholdStore } from '../store'
import { PersonalJournalStore } from '../personalJournal'
import { parsePersonalJournalQuery, personalJournalWriteSchema } from '../personalJournalContract'

let database: Database.Database, identities: HouseholdStore, journal: PersonalJournalStore
let now: number, zone: string, owner: string, member: string, directory: string
const date = '2026-11-10'
const fields = { restfulness: 4, comfort: 'warm' as const, caffeine: false, alcohol: false, exercise: false, notes: 'A private personal observation.' }
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
const secret = () => randomBytes(32).toString('base64url')
const request = () => ({ ...context(), date, expectedRevision: null, expectedTimeZone: zone, fields })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-personal-journal-'))
  database = migratedComfortDatabase(join(directory, 'configuration.db'))
  now = Date.parse('2026-11-11T12:00:00Z')
  zone = 'America/Los_Angeles'
  identities = new HouseholdStore(database, () => now)
  owner = secret()
  member = secret()
  identities.setup({ requestId: randomUUID(), displayName: 'Example owner', deviceName: 'Phone', deviceSecret: owner,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(owner, { ...context(), kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, displayName: 'Example member', deviceName: 'Tablet', deviceSecret: member })
  journal = new PersonalJournalStore(database, identities, () => zone, () => now)
})
afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('person-owned self-reports', () => {
  it('keeps two accounts separate for the same date before either has a fixed side', () => {
    journal.write(owner, request())
    expect(journal.read(member, date).record).toBeNull()
    journal.write(member, { ...request(), fields: { ...fields, comfort: 'cold', notes: 'A different person.' } })
    expect(journal.read(owner, date).record?.fields).toEqual(fields)
    expect(journal.read(member, date).record?.fields.comfort).toBe('cold')
    expect(identities.session(member).self.zones).toEqual([])
  })

  it('does not write legacy side feedback, control policy, model records or sensor history', () => {
    journal.write(owner, request())
    for (const table of ['journal_entries', 'comfort_feedback', 'comfort_models', 'comfort_states', 'comfort_events',
      'bedtime_routines', 'household_learning_records', 'household_person_records']) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
  })

  it('retains the original person and source calendar across an assignment change', () => {
    journal.write(owner, request())
    const original = journal.read(owner, date)
    database.prepare('UPDATE households SET mode = ?, assignment_revision = assignment_revision + 1').run('assigned')
    database.prepare('UPDATE household_accounts SET assigned_side = ? WHERE id = ?').run('right', identities.session(owner).accountId)
    expect(journal.read(owner, date)).toEqual(original)
    expect(journal.read(member, date).record).toBeNull()
    expect(() => journal.write(owner, { ...request(), expectedRevision: original.revision })).toThrow('assignment changed')
  })

  it('reconciles a lost write with one receipt and rejects altered or cross-account replay', () => {
    const input = request(), receipt = journal.write(owner, input)
    now += 1_000
    expect(journal.write(owner, input)).toEqual(receipt)
    expect(journal.receipt(owner, input.requestId)).toEqual(receipt)
    expect(journal.receipt(member, input.requestId)).toBeNull()
    expect(() => journal.write(member, input)).toThrow('identifier')
    expect(() => journal.write(owner, { ...input, fields: { ...fields, notes: 'Changed' } })).toThrow('identifier')
    expect(database.prepare('SELECT COUNT(*) AS count FROM household_mutation_receipts WHERE kind = ?').get('personal_journal')).toEqual({ count: 1 })
  })

  it('deletes content without retaining notes in receipts or resurrecting an old save', () => {
    const input = request(), saved = journal.write(owner, input)
    const deleted = journal.write(owner, { ...request(), expectedRevision: saved.revision, fields: null })
    expect(deleted.outcome).toBe('deleted')
    expect(journal.read(owner, date)).toEqual({ date, revision: deleted.revision, timeZone: zone, record: null })
    expect(journal.list(owner, date, date)).toEqual([])
    expect(journal.write(owner, input)).toEqual(saved)
    expect(journal.read(owner, date).record).toBeNull()
    const stored = JSON.stringify(['household_journal_entries', 'household_mutation_receipts']
      .map(table => database.prepare(`SELECT * FROM ${table}`).all()))
    expect(stored).not.toContain(fields.notes)
    expect(() => journal.write(owner, { ...input, requestId: randomUUID() })).toThrow('another device')
    journal.write(owner, { ...request(), expectedRevision: deleted.revision, fields: { ...fields, notes: 'Explicitly recreated.' } })
    expect(journal.read(owner, date).record?.fields.notes).toBe('Explicitly recreated.')
  })

  it('rejects resource, session and assignment revisions before changing content', () => {
    const saved = journal.write(owner, request())
    expect(() => journal.write(owner, request())).toThrow('another device')
    expect(() => journal.write(owner, { ...request(), expectedRevision: saved.revision, expectedSessionRevision: 2 })).toThrow('account')
    expect(() => journal.write(owner, { ...request(), expectedRevision: saved.revision, expectedAssignmentRevision: 2 })).toThrow('assignment')
    expect(journal.read(owner, date).revision).toBe(saved.revision)
  })

  it('retains the check-in time zone after travel and rejects a mismatched editor', () => {
    const saved = journal.write(owner, request())
    zone = 'Asia/Tokyo'
    expect(() => journal.write(owner, { ...request(), expectedRevision: saved.revision })).toThrow('time zone')
    journal.write(owner, { ...request(), expectedRevision: saved.revision, expectedTimeZone: 'America/Los_Angeles' })
    expect(journal.read(owner, date).timeZone).toBe('America/Los_Angeles')
  })

  it('validates detailed habit times across the real daylight-saving day', () => {
    const contextFields = { version: 1, caffeine: { status: 'yes', unit: 'milligrams', amount: 80, lastAt: Date.parse('2026-11-01T09:30:00Z') },
      alcohol: { status: 'none', unit: 'usStandardDrinks' }, exercise: { status: 'not_logged', unit: 'minutes' }, stress: 'usual' }
    const input = { ...request(), date: '2026-11-01', fields: { ...fields, caffeine: true, context: contextFields } }
    const saved = journal.write(owner, input)
    const withoutDetail = { ...input, ...context(), expectedRevision: saved.revision, fields: { ...fields, caffeine: true } }
    journal.write(owner, withoutDetail)
    expect(journal.read(owner, input.date).record?.fields.context).toEqual(contextFields)
    expect(() => journal.write(member, { ...input, ...context(), fields: { ...input.fields, context: { ...contextFields,
      caffeine: { ...contextFields.caffeine, lastAt: Date.parse('2026-11-03T09:30:00Z') } } } })).toThrow('Habit times')
  })

  it('rejects future dates and skipped local-calendar dates', () => {
    expect(() => journal.write(owner, { ...request(), date: '2026-11-12' })).toThrow('future')
    zone = 'Pacific/Apia'
    expect(() => journal.write(owner, { ...request(), date: '2011-12-30' })).toThrow('does not occur')
  })

  it('rejects backward clocks after a deletion as well as after a saved note', () => {
    const saved = journal.write(owner, request())
    now += 60_000
    const deleted = journal.write(owner, { ...request(), expectedRevision: saved.revision, fields: null })
    now -= 1
    expect(() => journal.write(owner, { ...request(), expectedRevision: deleted.revision })).toThrow('clock')
  })

  it('rolls back content when the receipt cannot commit', () => {
    database.exec('CREATE TRIGGER reject_journal_receipt BEFORE INSERT ON household_mutation_receipts WHEN NEW.kind = \'personal_journal\' BEGIN SELECT RAISE(ABORT, \'fixture receipt failure\'); END')
    expect(() => journal.write(owner, request())).toThrow('fixture receipt failure')
    expect(journal.read(owner, date).revision).toBeNull()
  })

  it('preserves saved content and tombstone replay after SQLite reopens', () => {
    const input = request(), saved = journal.write(owner, input)
    const filename = database.name
    database.close()
    database = migratedComfortDatabase(filename)
    identities = new HouseholdStore(database, () => now)
    journal = new PersonalJournalStore(database, identities, () => zone, () => now)
    expect(journal.write(owner, input)).toEqual(saved)
    expect(journal.read(owner, date).record?.fields).toEqual(fields)
  })

  it('returns descending bounded dates and rejects invalid direct-store ranges', () => {
    journal.write(owner, request())
    journal.write(owner, { ...request(), date: '2026-11-09' })
    expect(journal.list(owner, '2026-11-09', date).map(entry => entry.date)).toEqual([date, '2026-11-09'])
    expect(() => journal.list(owner, '2026-01-01', date)).toThrow()
    expect(() => journal.list(owner, date, '2026-11-09')).toThrow()
    expect(() => journal.read(owner, '2026-02-30')).toThrow()
  })

  it('withdraws access after device revocation and rejects inconsistent stored ownership', () => {
    const input = request()
    journal.write(owner, input)
    database.prepare('UPDATE household_journal_entries SET sleeper_id = ?').run(identities.session(member).selfSleeperId)
    expect(() => journal.read(owner, date)).toThrow('identity')
    database.prepare('UPDATE household_devices SET revoked_at = ?').run(now)
    expect(() => journal.read(owner, date)).toThrow('revoked')
    expect(() => journal.receipt(owner, input.requestId)).toThrow('revoked')
    expect(() => journal.write(owner, input)).toThrow('revoked')
  })

  it.each(['side', 'accountId', 'sleeperId', 'householdId'])('rejects caller-supplied scope %s', (field) => {
    expect(() => personalJournalWriteSchema.parse({ ...request(), [field]: 'another identity' })).toThrow()
  })

  it.each(['', 'date=2026-11-10&date=2026-11-09', 'date=2026-11-10&side=left', 'from=2026-01-01&through=2026-11-10',
    'from=2026-11-10&through=2026-11-09', 'date=2026-02-30', '__proto__=x'])('rejects ambiguous or invalid read selectors %s', (query) => {
    expect(() => parsePersonalJournalQuery(new URLSearchParams(query))).toThrow()
  })
})
