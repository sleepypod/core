import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { createComfortStore, comfortEvent } from '@/src/comfort/store'
import { defaultComfortState } from '@/src/comfort/policy'
import { withSideLock } from '@/src/hardware/sideLock'
import { historyDayStart, shiftHistoryDate } from '@/src/lib/localDates'
import { createJournalStore } from '../store'
import { journalRecordSchema, journalWriteSchema, type JournalFields, type JournalSelection } from '../contract'
import { JournalService } from '../service'
import { readJournalPresence } from '../presence'
import { journalPatterns } from '../patterns'

const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const fields: JournalFields = { restfulness: 4, comfort: 'warm', caffeine: true, alcohol: false, exercise: true, notes: 'Private synthetic note' }
const now = Date.parse('2026-10-25T10:00:00Z')
const date = '2026-10-24'
const zone = 'America/Los_Angeles'
function fixture() {
  const database = migratedComfortDatabase()
  databases.push(database)
  const store = createJournalStore(database)
  const comfort = createComfortStore(database)
  const service = new JournalService({ store, now: () => now, timeZone: () => zone, withSideLock, presence: () => [] })
  return { database, store, comfort, service }
}
const first = () => ({ side: 'left' as const, date, expectedRevision: null, fields })

describe('revision-checked private morning journal', () => {
  it('persists every field and atomically synchronizes feedback without private notes in events', () => {
    const { database, store, comfort } = fixture()
    const saved = store.write(first(), zone, now)
    expect(saved.record).toEqual({ side: 'left', date, fields, timeZone: zone, origin: 'sleepypod', createdAt: now, updatedAt: now, importedAt: null })
    expect(createJournalStore(database).read('left', date)).toEqual(saved)
    expect(comfort.feedback('left')).toEqual([{ date, comfort: 'warm' }])
    expect(JSON.stringify(comfort.history('left'))).not.toContain(fields.notes)
    expect(store.read('right', date)).toMatchObject({ revision: null, record: null })
  })

  it('rejects lost-update retries and prevents delete/recreate ABA', () => {
    const { store, comfort } = fixture()
    const saved = store.write(first(), zone, now)
    expect(() => store.write(first(), zone, now)).toThrow('changed on another device')
    const removed = store.write({ ...first(), expectedRevision: saved.revision, fields: null }, zone, now + 1)
    expect(removed).toMatchObject({ record: null })
    expect(removed.revision).not.toBe(saved.revision)
    expect(comfort.feedback('left')).toEqual([])
    expect(store.list('left', date, date)).toEqual([])
    expect(() => store.write({ ...first(), expectedRevision: saved.revision }, zone, now + 2)).toThrow('changed on another device')
    expect(() => store.write(first(), zone, now + 2)).toThrow('changed on another device')
    expect(store.write({ ...first(), expectedRevision: removed.revision }, zone, now + 2).record?.fields).toEqual(fields)
  })

  it('rolls back the entry if feedback/event persistence fails', () => {
    const { database, store, comfort } = fixture()
    database.exec('CREATE TRIGGER fail_feedback BEFORE INSERT ON comfort_events BEGIN SELECT RAISE(ABORT, \'synthetic disk failure\'); END')
    expect(() => store.write(first(), zone, now)).toThrow('synthetic disk failure')
    expect(store.read('left', date)).toMatchObject({ record: null, revision: null })
    expect(comfort.feedback('left')).toEqual([])
  })

  it('preserves imported provenance and unknown creation time when editing from a new timezone', () => {
    const { database, store } = fixture()
    const record = { side: 'left', date, fields, timeZone: 'UTC', origin: 'free-sleep', createdAt: null, updatedAt: null, importedAt: now - 1 }
    const revision = randomUUID()
    database.prepare('INSERT INTO journal_entries VALUES (?,?,?,?)').run('left', date, revision, JSON.stringify(record))
    const saved = store.write({ ...first(), expectedRevision: revision, fields: { ...fields, notes: 'Edited' } }, zone, now)
    expect(saved.record).toMatchObject({ timeZone: 'UTC', origin: 'free-sleep', createdAt: null, importedAt: now - 1, updatedAt: now })
  })

  it('comfort-only updates preserve notes, rotate revisions and never rewind consumed learning', () => {
    const { store, comfort } = fixture()
    const saved = store.write(first(), zone, now)
    const state = { ...defaultComfortState(), feedbackThrough: date, offsetF: -2, learnedSession: 'already-consumed' }
    comfort.commit('left', state)
    comfort.saveFeedback('left', { date, comfort: 'cold' }, comfortEvent(now, 'feedback', 'Synthetic feedback'))
    expect(store.read('left', date).record?.fields).toEqual({ ...fields, comfort: 'cold' })
    expect(store.read('left', date).revision).not.toBe(saved.revision)
    expect(comfort.read('left')).toEqual(state)
    expect(() => store.write({ ...first(), expectedRevision: saved.revision }, zone, now)).toThrow('changed on another device')
  })

  it('refuses malformed or mismatched persisted entries instead of replacing them', () => {
    const { database, store } = fixture()
    database.prepare('INSERT INTO journal_entries VALUES (?,?,?,?)').run('left', date, randomUUID(), '{broken')
    expect(() => store.read('left', date)).toThrow()
    expect(() => store.write(first(), zone, now)).toThrow()
    expect(database.prepare('SELECT record FROM journal_entries').get()).toEqual({ record: '{broken' })
  })

  it('accesses old selected dates independently of today and rejects future/impossible dates', async () => {
    const { service } = fixture()
    await service.write({ ...first(), date: '2021-11-07' })
    expect(service.read({ side: 'left', date: '2021-11-07', days: 30 })).toMatchObject({ from: '2021-10-09', through: '2021-11-07', selected: { record: { date: '2021-11-07' } } })
    expect(service.read({ side: 'left' }).entries).toEqual([])
    await expect(service.write({ ...first(), date: '2026-10-26' })).rejects.toThrow('future local date')
    expect(() => journalWriteSchema.parse({ ...first(), date: '2026-02-30' })).toThrow()
    expect(() => journalWriteSchema.parse({ ...first(), fields: { ...fields, notes: 'x'.repeat(501) } })).toThrow()
    expect(() => journalWriteSchema.parse({ ...first(), extra: true })).toThrow()
  })

  it('serializes simultaneous same-side edits and returns a conflict to the loser', async () => {
    const { service } = fixture()
    const results = await Promise.allSettled([service.write(first()), service.write({ ...first(), fields: { ...fields, restfulness: 1 } })])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
  })
})

describe('source-separated bed-presence associations', () => {
  function presenceFixture() {
    const { database } = fixture()
    database.exec('CREATE TABLE sleep_records(id INTEGER PRIMARY KEY,side TEXT,entered_bed_at INTEGER,left_bed_at INTEGER,present_intervals TEXT)')
    const insert = (side: string, start: number, end: number, intervals: unknown) => database.prepare('INSERT INTO sleep_records(side,entered_bed_at,left_bed_at,present_intervals) VALUES (?,?,?,?)').run(side, start, end, JSON.stringify(intervals))
    return { database, insert }
  }
  it('unions duplicate intervals, excludes missing/invalid dates and uses source-local wake day over DST', () => {
    const { database, insert } = presenceFixture()
    const start = Date.parse('2026-11-01T07:00:00Z') / 1000
    insert('left', start, start + 7200, [[start, start + 7200]])
    insert('left', start, start + 7200, [[start + 3600, start + 7200]])
    insert('right', start, start + 7200, [[start, start + 7200]])
    const capturedAt = Date.parse('2026-11-02T12:00:00Z')
    const result = readJournalPresence(database, 'left', '2026-11-01', '2026-11-01', zone, capturedAt)
    expect([...result.minutes]).toEqual([['2026-11-01', 120]])
    insert('left', start, start + 7200, null)
    expect(readJournalPresence(database, 'left', '2026-11-01', '2026-11-01', zone, capturedAt).minutes.size).toBe(0)
    expect(historyDayStart('2026-11-02', zone) - historyDayStart('2026-11-01', zone)).toBe(25 * 3600_000)
  })

  it('refuses a partial result when the row or aggregate JSON budget is exceeded', () => {
    const { database, insert } = presenceFixture()
    const start = Date.parse('2026-10-24T12:00:00Z') / 1000
    for (let index = 0; index < 1001; index++) insert('left', start, start + 60, [[start, start + 60]])
    expect(readJournalPresence(database, 'left', date, date, zone)).toMatchObject({ status: 'too_many_records', minutes: new Map() })
    database.exec('DELETE FROM sleep_records')
    const large = ' '.repeat(200_000)
    for (let index = 0; index < 45; index++) insert('left', start, start + 60, large)
    expect(readJournalPresence(database, 'left', date, date, zone)).toMatchObject({ status: 'too_many_records', minutes: new Map() })
  })

  it('excludes future wake timestamps within the current local date', () => {
    const { database, insert } = presenceFixture()
    const start = Date.parse('2026-10-24T12:00:00Z') / 1000
    insert('left', start, start + 7200, [[start, start + 7200]])
    expect(readJournalPresence(database, 'left', date, date, zone, (start + 3600) * 1000).minutes.size).toBe(0)
    expect(readJournalPresence(database, 'left', date, date, zone, (start + 7201) * 1000).minutes.get(date)).toBe(120)
  })

  it('requires five dates in each group within each source and excludes mismatched zones', () => {
    const entries: JournalSelection[] = []
    const minutes = new Map<string, number>()
    for (let index = 0; index < 10; index++) {
      const date = shiftHistoryDate('2026-10-24', -index)
      entries.push({ side: 'left', date, revision: randomUUID(), record: journalRecordSchema.parse({
        side: 'left', date, fields: { ...fields, caffeine: index < 5 }, timeZone: zone,
        origin: 'sleepypod', createdAt: now, updatedAt: now, importedAt: null,
      }) })
      minutes.set(date, index < 5 ? 360 : 420)
    }
    const current = { source: 'sleepypod' as const, presence: { status: 'ready' as const, timeZone: zone, minutes } }
    const legacy = { source: 'free-sleep' as const, presence: { status: 'ready' as const, timeZone: zone, minutes: new Map([...minutes].slice(0, 5)) } }
    const patterns = journalPatterns(entries, [current, legacy])
    expect(patterns.cohorts[0].associations).toEqual([{ habit: 'caffeine', withCount: 5, withoutCount: 5, presenceDifferenceMinutes: -60 }])
    expect(patterns.cohorts[1].associations).toEqual([])
    expect(patterns.recentEntries).toBe(7)
    expect(JSON.stringify(patterns)).not.toContain(fields.notes)
    const firstRecord = entries[0].record
    if (!firstRecord) throw new Error('Missing fixture record')
    firstRecord.timeZone = 'UTC'
    expect(journalPatterns(entries, [current]).cohorts[0]).toMatchObject({ matchedDates: 9, excludedDates: 1, associations: [] })
  })
})
