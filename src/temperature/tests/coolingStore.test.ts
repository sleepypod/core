import { randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, describe, expect, it } from 'vitest'
import { createCoolingStore } from '../coolingStore'
import type { CoolingLease } from '../cooling'

const databases: Database.Database[] = []
afterEach(() => {
  for (const database of databases.splice(0)) database.close()
})
function setup() {
  const database = new Database(':memory:')
  databases.push(database)
  migrate(drizzle(database), { migrationsFolder: path.resolve('src/db/migrations') })
  const store = createCoolingStore(database)
  const lease: CoolingLease = { version: 1, id: randomUUID(), side: 'left', scope: 'a'.repeat(64),
    fromTargetF: 70, targetF: 68, startedAt: 1_000, expiresAt: 1_201_000, sessionEndsAt: 10_000_000, phase: 'prepared' }
  return { database, store, lease }
}

describe('durable cooling and explicit comfort moments', () => {
  it('retains intent across controller reconstruction without altering the morning rating', () => {
    const { database, store, lease } = setup()
    database.prepare('INSERT INTO comfort_feedback (side,local_date,comfort,recorded_at) VALUES (?,?,?,?)').run('left', '2026-11-10', 'comfortable', 100)
    store.begin(lease)
    expect(createCoolingStore(database).read('left')).toEqual(lease)
    const row = database.prepare('SELECT record FROM comfort_moments WHERE id=?').get(lease.id) as { record: string }
    expect(JSON.parse(row.record)).toMatchObject({ feeling: 'too_hot', attribution: 'physical_zone_only', physicalVerification: 'unverified' })
    store.write('left', { ...lease, phase: 'active' })
    store.write('left', null)
    expect(store.read('left')).toBeNull()
    expect(database.prepare('SELECT count(*) AS count FROM comfort_moments').get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT comfort FROM comfort_feedback').get()).toEqual({ comfort: 'comfortable' })
    expect(() => store.begin(lease)).toThrow()
    expect(store.read('left')).toBeNull()
  })

  it('rolls back feedback when durable intent cannot be written', () => {
    const { database, store, lease } = setup()
    database.exec('CREATE TRIGGER reject_cooling BEFORE INSERT ON temporary_cooling BEGIN SELECT RAISE(ABORT, \'disk full\'); END')
    expect(() => store.begin(lease)).toThrow('disk full')
    expect(database.prepare('SELECT count(*) AS count FROM comfort_moments').get()).toEqual({ count: 0 })
    expect(store.read('left')).toBeNull()
  })

  it('rejects malformed cross-side records and duplicate active intent', () => {
    const { database, store, lease } = setup()
    store.begin(lease)
    expect(() => store.write('right', lease)).toThrow('side')
    expect(() => store.begin({ ...lease, id: randomUUID() })).toThrow('already exists')
    database.prepare('UPDATE temporary_cooling SET record=? WHERE side=?').run(JSON.stringify({ ...lease, side: 'right' }), 'left')
    expect(() => store.read('left')).toThrow('side')
  })
})
