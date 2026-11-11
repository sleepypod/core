import { afterEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { historyDayStart, shiftHistoryDate } from '@/src/lib/localDates'
import { contextTimesAreValid, journalContextSchema, type JournalContext } from '../context'
import { journalFieldsSchema, type JournalFields, type JournalSelection } from '../contract'
import { createJournalStore } from '../store'
import { journalPatterns } from '../patterns'

const date = '2026-11-01'
const zone = 'America/Los_Angeles'
const now = Date.parse('2026-11-01T18:00:00Z')
const databases: ReturnType<typeof migratedComfortDatabase>[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
const context = (): JournalContext => ({
  version: 1,
  caffeine: { status: 'yes', amount: 120, unit: 'milligrams', lastAt: Date.parse('2026-10-31T20:00:00Z') },
  alcohol: { status: 'not_logged', unit: 'usStandardDrinks' },
  exercise: { status: 'yes', amount: 45, unit: 'minutes', lastAt: Date.parse('2026-11-01T01:00:00Z') },
  lastMealAt: Date.parse('2026-11-01T03:00:00Z'), stress: 'higher',
})
const legacyFields: JournalFields = { restfulness: 3, comfort: 'comfortable', caffeine: true, alcohol: false, exercise: true, notes: '' }
const request = () => ({ side: 'left' as const, date, expectedRevision: null, fields: { ...legacyFields, context: context() } })
function storeFixture() {
  const database = migratedComfortDatabase()
  databases.push(database)
  return { database, store: createJournalStore(database) }
}

describe('optional habit context semantics', () => {
  it('keeps unlogged, reported absence, missing quantity and explicit zero distinct', () => {
    const unknown = context()
    const none = { ...unknown, alcohol: { ...unknown.alcohol, status: 'none' as const } }
    const yes = { ...unknown, alcohol: { ...unknown.alcohol, status: 'yes' as const } }
    const zero = { ...yes, alcohol: { ...yes.alcohol, amount: 0 } }
    const results = [unknown, none, yes, zero].map(value => journalContextSchema.parse(value))
    expect(new Set(results.map(value => JSON.stringify(value))).size).toBe(4)
    expect(results[2].alcohol.amount).toBeUndefined()
    expect(results[3].alcohol.amount).toBe(0)
  })
  it.each([-1, Infinity, NaN, 10_001])('rejects invalid caffeine amount %s', (amount) => {
    const value = context()
    value.caffeine.amount = amount
    expect(journalContextSchema.safeParse(value).success).toBe(false)
  })
  it('rejects wrong units, unknown versions and quantitative detail without a logged habit', () => {
    const value = context()
    expect(journalContextSchema.safeParse({ ...value, caffeine: { ...value.caffeine, unit: 'minutes' } }).success).toBe(false)
    expect(journalContextSchema.safeParse({ ...value, version: 2 }).success).toBe(false)
    expect(journalContextSchema.safeParse({ ...value, alcohol: { ...value.alcohol, amount: 0 } }).success).toBe(false)
    expect(journalContextSchema.safeParse({ ...value, alcohol: { ...value.alcohol, lastAt: now } }).success).toBe(false)
    expect(journalFieldsSchema.safeParse({ ...legacyFields, caffeine: false, context: value }).success).toBe(false)
  })
  it('uses calendar boundaries across DST and rejects future or out-of-window times', () => {
    const start = historyDayStart('2026-10-31', zone)
    const end = historyDayStart('2026-11-02', zone)
    expect(end - start).toBe(49 * 3600_000)
    for (const time of [start, start + 1, now]) {
      const value = context()
      value.caffeine.lastAt = time
      expect(contextTimesAreValid(value, date, zone, now)).toBe(true)
    }
    for (const time of [start - 1, now + 1, end]) {
      const value = context()
      value.caffeine.lastAt = time
      expect(contextTimesAreValid(value, date, zone, now)).toBe(false)
    }
    expect(contextTimesAreValid(context(), date, zone, NaN)).toBe(false)
    const untimed = { ...context(), caffeine: { status: 'not_logged' as const, unit: 'milligrams' as const }, exercise: { status: 'not_logged' as const, unit: 'minutes' as const }, lastMealAt: undefined }
    expect(contextTimesAreValid(untimed, '2026-11-02', zone, now)).toBe(false)
    expect(contextTimesAreValid(context(), date, 'Unknown/Zone', now)).toBe(false)
  })
  it('preserves detailed records when an older client only edits notes', () => {
    const { store } = storeFixture()
    const first = store.write(request(), zone, now)
    const edited = store.write({ ...request(), expectedRevision: first.revision, fields: { ...legacyFields, notes: 'Edited from older app' } }, zone, now + 1)
    expect(edited.record?.fields.context).toEqual(context())
    expect(edited.record?.fields.notes).toBe('Edited from older app')
    expect(edited.revision).not.toBe(first.revision)
  })
  it('clears only incompatible detail when an older client changes a habit', () => {
    const { store } = storeFixture()
    const first = store.write(request(), zone, now)
    const changed = store.write({ ...request(), expectedRevision: first.revision, fields: { ...legacyFields, caffeine: false, alcohol: true } }, zone, now + 1)
    expect(changed.record?.fields.context?.caffeine).toEqual({ status: 'none', unit: 'milligrams' })
    expect(changed.record?.fields.context?.alcohol).toEqual({ status: 'yes', unit: 'usStandardDrinks' })
    expect(changed.record?.fields.context?.exercise).toEqual(context().exercise)
    expect(changed.record?.fields.context?.stress).toBe('higher')
  })
  it('rejects a new-entry time-zone race before writing and retains the original zone on later edits', () => {
    const { store } = storeFixture()
    expect(() => store.write({ ...request(), expectedTimeZone: zone }, 'America/New_York', now)).toThrow('time zone changed')
    expect(store.read('left', date).record).toBeNull()
    const first = store.write({ ...request(), expectedTimeZone: zone }, zone, now)
    expect(store.write({ ...request(), expectedTimeZone: zone, expectedRevision: first.revision }, 'America/New_York', now + 1).record?.timeZone).toBe(zone)
  })
  it('allows explicit removal and keeps the same conflict and side boundaries', () => {
    const { store } = storeFixture()
    const first = store.write(request(), zone, now)
    expect(() => store.write(request(), zone, now)).toThrow('changed on another device')
    expect(store.read('right', date).record).toBeNull()
    const removed = store.write({ ...request(), expectedRevision: first.revision, fields: { ...legacyFields, context: null } }, zone, now + 1)
    expect(removed.record?.fields.context).toBeNull()
    expect(removed.record?.fields.comfort).toBe('comfortable')
  })
  it('rejects invalid timing without touching the journal, feedback or event tables', () => {
    const { database, store } = storeFixture()
    const invalid = request()
    invalid.fields.context.lastMealAt = now + 1
    expect(() => store.write(invalid, zone, now)).toThrow('cannot be in the future')
    for (const table of ['journal_entries', 'comfort_feedback', 'comfort_events']) {
      expect(database.prepare(`SELECT count(*) AS count FROM ${table}`).get()).toEqual({ count: 0 })
    }
  })
  it('retains the existing entry zone and keeps timing and quantities out of learning events', () => {
    const { database, store } = storeFixture()
    const first = store.write(request(), zone, now)
    const changed = store.write({ ...request(), expectedRevision: first.revision }, 'Pacific/Auckland', now + 1)
    expect(changed.record?.timeZone).toBe(zone)
    expect(changed.record?.fields.context).toEqual(context())
    const events = JSON.stringify(database.prepare('SELECT event FROM comfort_events').all())
    for (const detail of ['lastMealAt', 'milligrams', 'higher']) expect(events).not.toContain(detail)
  })
  it('excludes explicitly unlogged habits from the without-habit comparison', () => {
    const { store } = storeFixture()
    const entries: JournalSelection[] = []
    const minutes = new Map<string, number>()
    for (let index = 0; index < 10; index++) {
      const entryDate = shiftHistoryDate(date, -index)
      const fields = { ...legacyFields, alcohol: index < 5, context: context() }
      fields.context.caffeine = { status: 'yes', unit: 'milligrams' }
      fields.context.exercise = { status: 'yes', unit: 'minutes' }
      delete fields.context.lastMealAt
      fields.context.alcohol = { status: index < 5 ? 'yes' : 'not_logged', unit: 'usStandardDrinks' }
      entries.push(store.write({ side: 'left', date: entryDate, expectedRevision: null, fields }, zone, now))
      minutes.set(entryDate, 420)
    }
    const result = journalPatterns(entries, [{ source: 'sleepypod', presence: { status: 'ready', timeZone: zone, minutes } }])
    expect(result.cohorts[0].matchedDates).toBe(10)
    expect(result.cohorts[0].associations).toEqual([])
  })
})
