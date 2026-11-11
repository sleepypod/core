import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HardwareAdmissionStore } from '../admissionStore'
import { HardwareAdmissionError } from '../admission'

let folder: string, database: Database.Database, store: HardwareAdmissionStore
beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'sleepypod-admission-'))
  database = new Database(path.join(folder, 'configuration.db'))
  database.pragma('journal_mode = WAL')
  migrate(drizzle(database), { migrationsFolder: path.resolve('src/db/migrations') })
  store = new HardwareAdmissionStore(database, () => 1794399000000)
})
afterEach(() => {
  if (database?.open) database.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('persisted hardware hold', () => {
  it('commits a synchronous receipt with the hold and rolls both back if either write fails', () => {
    database.exec('CREATE TABLE test_receipt (id TEXT PRIMARY KEY, revision INTEGER NOT NULL)')
    const operationId = randomUUID()
    expect(() => store.holdWithReceipt(operationId, (admission) => {
      database.prepare('INSERT INTO test_receipt VALUES (?, ?)').run(operationId, admission.revision)
      throw new Error('receipt write interrupted')
    })).toThrow('receipt write interrupted')
    expect(store.read()).toEqual({ revision: 1, holdId: null })
    expect(database.prepare('SELECT * FROM test_receipt').all()).toEqual([])
    store.holdWithReceipt(operationId, admission => database.prepare('INSERT INTO test_receipt VALUES (?, ?)').run(operationId, admission.revision))
    expect(database.prepare('SELECT revision FROM test_receipt').get()).toEqual({ revision: 2 })
    expect(store.holdWithReceipt(operationId, admission => admission.revision)).toEqual({ admission: { revision: 2, holdId: operationId }, result: 2 })
  })
  it('requires the exact hold across the complete configuration transaction', () => {
    database.pragma('synchronous = NORMAL')
    const operationId = randomUUID()
    store.hold(operationId)
    expect(() => store.transactionWhileHeld(operationId, 1, () => undefined)).toThrow()
    expect(() => store.transactionWhileHeld(randomUUID(), 2, () => undefined)).toThrow()
    expect(() => store.transactionWhileHeld(operationId, 2, () => {
      database.prepare('UPDATE hardware_admission SET hold_id = NULL, held_at = NULL').run()
    })).toThrow()
    expect(store.read()).toEqual({ revision: 2, holdId: operationId })
    expect(() => store.transactionWhileHeld(operationId, 2, () => Promise.resolve())).toThrow('synchronous')
    expect(store.transactionWhileHeld(operationId, 2, () => 'saved').result).toBe('saved')
    expect(database.pragma('synchronous', { simple: true })).not.toBe(2)
  })
  it('starts open exactly once and survives restart without reopening an unresolved hold', () => {
    expect(store.read()).toEqual({ revision: 1, holdId: null })
    const operationId = randomUUID()
    expect(store.hold(operationId)).toEqual({ revision: 2, holdId: operationId })
    expect(store.hold(operationId)).toEqual({ revision: 2, holdId: operationId })
    database.close()
    database = new Database(path.join(folder, 'configuration.db'))
    migrate(drizzle(database), { migrationsFolder: path.resolve('src/db/migrations') })
    store = new HardwareAdmissionStore(database)
    expect(store.read()).toEqual({ revision: 2, holdId: operationId })
    expect(store.release(operationId, 2)).toEqual({ revision: 3, holdId: null })
    expect(() => store.release(operationId, 2)).toThrow(HardwareAdmissionError)
  })
  it('requires the same hold and revision and never steals another operation', () => {
    const operationId = randomUUID(), other = randomUUID()
    store.hold(operationId)
    expect(() => store.hold(other)).toThrow(HardwareAdmissionError)
    expect(() => store.release(other, 2)).toThrow(HardwareAdmissionError)
    expect(() => store.release(operationId, 1)).toThrow(HardwareAdmissionError)
    expect(store.read()).toEqual({ revision: 2, holdId: operationId })
  })
  it('never repairs missing state when migrations or hold are retried', () => {
    database.prepare('DELETE FROM hardware_admission').run()
    migrate(drizzle(database), { migrationsFolder: path.resolve('src/db/migrations') })
    expect(() => store.read()).toThrow(HardwareAdmissionError)
    expect(() => store.hold(randomUUID())).toThrow(HardwareAdmissionError)
    expect(database.prepare('SELECT * FROM hardware_admission').all()).toEqual([])
  })
  it.each([
    'UPDATE hardware_admission SET revision = 0', 'UPDATE hardware_admission SET hold_id = \'invalid\'',
    'UPDATE hardware_admission SET held_at = 123', 'INSERT INTO hardware_admission (id, revision) VALUES (2, 1)',
  ])('rejects corrupt state: %s', (statement) => {
    database.exec(statement)
    expect(() => store.read()).toThrow(HardwareAdmissionError)
    expect(() => store.hold(randomUUID())).toThrow(HardwareAdmissionError)
  })
  it('does not overflow revisions or release a hold when storage fails', () => {
    database.prepare('UPDATE hardware_admission SET revision = ?').run(Number.MAX_SAFE_INTEGER)
    expect(() => store.hold(randomUUID())).toThrow(HardwareAdmissionError)
    database.prepare('UPDATE hardware_admission SET revision = 1').run()
    const operationId = randomUUID()
    store.hold(operationId)
    database.exec('CREATE TRIGGER reject_admission_write BEFORE UPDATE ON hardware_admission BEGIN SELECT RAISE(ABORT, \'disk write failed\'); END')
    expect(() => store.release(operationId, 2)).toThrow('disk write failed')
    expect(store.read()).toEqual({ revision: 2, holdId: operationId })
  })
  it('requires a separate commit boundary and restores the connection durability setting', () => {
    database.pragma('synchronous = NORMAL')
    const operationId = randomUUID()
    expect(() => database.transaction(() => store.hold(operationId))()).toThrow('independent durable')
    expect(store.read().revision).toBe(1)
    store.hold(operationId)
    expect(database.pragma('synchronous', { simple: true })).toBe(1)
    expect(() => store.hold(randomUUID())).toThrow(HardwareAdmissionError)
    expect(database.pragma('synchronous', { simple: true })).toBe(1)
  })
})
