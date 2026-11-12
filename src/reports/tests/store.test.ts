import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { MorningReportStore, ReportError, type ReportScope } from '../store'
import { appendAnswer, legacyReportScope, personalReportScope, reportFixture, reportNow } from './fixture'

let database: Database.Database, store: MorningReportStore, now: number, scope: ReportScope
beforeEach(() => {
  database = migratedComfortDatabase()
  now = reportNow
  store = new MorningReportStore(database, () => now)
  scope = legacyReportScope()
})
afterEach(() => database.close())

describe('private saved morning report library', () => {
  it('keeps the original facts, source, text and creation clock with an idempotent receipt', () => {
    const input = reportFixture(), saved = store.save(scope, input.report.id, input, null)
    expect(saved).toMatchObject({ id: input.report.id, createdAt: input.report.createdAt, receivedAt: now, updatedAt: now, deleted: false })
    expect(store.read(scope, input.report.id).report).toEqual(input.report)
    now += 1000
    const reordered = { report: { ...input.report, facts: input.report.facts }, version: 1 }
    expect(store.save(scope, input.report.id, reordered, null)).toEqual(saved)
    expect(store.list(scope)).toHaveLength(1)
    expect(JSON.stringify(store.list(scope))).not.toContain(input.report.text)
  })

  it('isolates identical report IDs across installations, people and the owner boundary', () => {
    const input = reportFixture(), people = [scope, legacyReportScope(), personalReportScope(), personalReportScope()]
    for (const [index, person] of people.entries()) store.save(person, input.report.id, { ...input, report: { ...input.report, text: `Only account ${index}` } }, null)
    for (const [index, person] of people.entries()) {
      expect(store.read(person, input.report.id).report?.text).toBe(`Only account ${index}`)
      expect(store.list(person)).toHaveLength(1)
    }
    expect(() => store.read(personalReportScope(), input.report.id)).toThrow('not in your shared library')
  })

  it('accepts only append-only answers with the current revision', () => {
    const input = reportFixture(), first = store.save(scope, input.report.id, input, null)
    const answered = appendAnswer(input), second = store.save(scope, input.report.id, answered, first.revision)
    expect(second.revision).not.toBe(first.revision)
    expect(second.createdAt).toBe(first.createdAt)
    expect(store.read(scope, input.report.id).report).toEqual(answered.report)
    expect(store.save(scope, input.report.id, answered, first.revision)).toEqual(second)
    expect(() => store.save(scope, input.report.id, appendAnswer(answered), first.revision)).toThrow(ReportError)
    expect(() => store.save(scope, input.report.id, input, second.revision)).toThrow(ReportError)
    const changed = structuredClone(answered)
    if (!changed.report.followUps?.[0]) throw new Error('Expected an answer fixture')
    changed.report.followUps[0].text = 'Rewritten prior answer'
    expect(() => store.save(scope, input.report.id, appendAnswer(changed), second.revision)).toThrow(ReportError)
  })

  it.each(['text', 'facts', 'model', 'createdAt', 'comparison'])('will not rewrite original %s while appending an answer', (field) => {
    const input = reportFixture(), saved = store.save(scope, input.report.id, input, null), edited = appendAnswer(input)
    Object.assign(edited.report, { [field]: field === 'createdAt' ? now - 2000 : field === 'facts' ? [] : field === 'comparison' ? { forged: true } : 'Rewritten' })
    expect(() => store.save(scope, input.report.id, edited, saved.revision)).toThrow(ReportError)
    expect(store.read(scope, input.report.id).report).toEqual(input.report)
  })

  it('removes shared content, retains a tombstone and rejects stale upload after deletion', () => {
    const input = reportFixture(), saved = store.save(scope, input.report.id, input, null)
    expect(() => store.remove(scope, input.report.id, null)).toThrow(ReportError)
    const deleted = store.remove(scope, input.report.id, saved.revision)
    expect(deleted.deleted).toBe(true)
    expect(store.read(scope, input.report.id)).toEqual({ receipt: deleted, report: null })
    expect(store.list(scope)).toEqual([])
    expect(store.remove(scope, input.report.id, saved.revision)).toEqual(deleted)
    expect(database.prepare('SELECT payload, original_hash, document_hash FROM morning_reports').get())
      .toEqual({ payload: null, original_hash: null, document_hash: null })
    expect(() => store.save(scope, input.report.id, input, null)).toThrow('deleted')
    expect(() => store.save(scope, input.report.id, appendAnswer(input), saved.revision)).toThrow('deleted')
  })

  it('can withdraw an upload that has not arrived yet, and cannot withdraw another person’s copy', () => {
    const input = reportFixture(), other = personalReportScope()
    store.save(other, input.report.id, input, null)
    const removed = store.remove(scope, input.report.id, null)
    expect(removed.createdAt).toBeNull()
    expect(() => store.save(scope, input.report.id, input, null)).toThrow('deleted')
    expect(store.read(other, input.report.id).report).toEqual(input.report)
  })

  it('normalizes UUID case across native and browser clients', () => {
    const input = reportFixture()
    input.report.id = input.report.id.toUpperCase()
    const saved = store.save(scope, input.report.id.toLowerCase(), input, null)
    expect(saved.id).toBe(input.report.id.toLowerCase())
    expect(store.read(scope, input.report.id).report?.id).toBe(saved.id)
  })

  it.each(['payload', 'hash', 'createdAt', 'revision', 'futureUpdate'])('withholds corrupt %s without returning private content', (field) => {
    const input = reportFixture()
    store.save(scope, input.report.id, input, null)
    const sql = { payload: 'UPDATE morning_reports SET payload = \'private-corruption-marker\'', hash: 'UPDATE morning_reports SET original_hash = \'bad\'',
      createdAt: 'UPDATE morning_reports SET created_at = created_at + 1', revision: 'UPDATE morning_reports SET revision = \'bad\'',
      futureUpdate: 'UPDATE morning_reports SET updated_at = updated_at + 1' }[field]
    if (!sql) throw new Error('Missing test mutation')
    database.exec(sql)
    expect(() => store.read(scope, input.report.id)).toThrow('needs review')
    expect(() => store.list(scope)).toThrow('needs review')
  })

  it('checks document ID, future dates and unknown identity fields before changing storage', () => {
    const input = reportFixture()
    expect(() => store.save(scope, randomUUID(), input, null)).toThrow('ID')
    expect(() => store.save(scope, input.report.id, { ...input, owner: 'another person' }, null)).toThrow('invalid')
    expect(() => store.save(scope, input.report.id, { ...input, report: { ...input.report, createdAt: now + 1 } }, null)).toThrow('invalid')
    expect(store.list(scope)).toEqual([])
  })

  it('bounds live reports without evicting evidence and retains deletion records', () => {
    const input = reportFixture()
    for (let index = 0; index < 100; index++) {
      const copy = reportFixture()
      store.save(scope, copy.report.id, copy, null)
    }
    expect(() => store.save(scope, input.report.id, input, null)).toThrow('full')
    const oldest = store.list(scope)[99]
    store.remove(scope, oldest.id, oldest.revision)
    store.save(scope, input.report.id, input, null)
    expect(store.list(scope)).toHaveLength(100)
    expect(store.read(scope, oldest.id).report).toBeNull()
  })

  it('survives reopening and rejects a concurrent writer’s stale revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sleepypod-report-reopen-')), filename = join(directory, 'reports.db')
    const firstDatabase = migratedComfortDatabase(filename), secondDatabase = migratedComfortDatabase(filename)
    try {
      const firstStore = new MorningReportStore(firstDatabase, () => now), secondStore = new MorningReportStore(secondDatabase, () => now)
      const input = reportFixture(), original = firstStore.save(scope, input.report.id, input, null)
      const changed = firstStore.save(scope, input.report.id, appendAnswer(input), original.revision)
      expect(() => secondStore.save(scope, input.report.id, appendAnswer(input, 'Competing answer'), original.revision)).toThrow(ReportError)
      expect(secondStore.read(scope, input.report.id).receipt).toEqual(changed)
      const deleted = secondStore.remove(scope, input.report.id, changed.revision)
      expect(firstStore.read(scope, input.report.id).receipt).toEqual(deleted)
    }
    finally {
      firstDatabase.close()
      secondDatabase.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('bounds retained deletion records without reopening old upload IDs', () => {
    const removed = store.remove(scope, randomUUID(), null)
    for (let index = 1; index < 1000; index++) store.remove(scope, randomUUID(), null)
    expect(() => store.remove(scope, randomUUID(), null)).toThrow('full')
    expect(store.read(scope, removed.id).receipt).toEqual(removed)
    expect(store.list(scope)).toEqual([])
  })
})
