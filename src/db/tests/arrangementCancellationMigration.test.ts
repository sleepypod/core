import { randomBytes, randomUUID } from 'node:crypto'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { expect, it } from 'vitest'
import { HouseholdStore } from '@/src/household/store'

it.each([65, 66])('upgrades maintenance receipts from migration %i without changing existing arrangements or holds', (lastMigration) => {
  const previous = mkdtempSync(path.join(tmpdir(), 'arrangement-cancellation-upgrade-'))
  const current = path.resolve('src/db/migrations')
  const database = new Database(':memory:')
  database.pragma('foreign_keys = ON')
  try {
    cpSync(current, previous, { recursive: true })
    const journalPath = path.join(previous, 'meta/_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] }
    journal.entries = journal.entries.filter(entry => entry.idx <= lastMigration)
    writeFileSync(journalPath, JSON.stringify(journal))
    migrate(drizzle(database), { migrationsFolder: previous })
    const identities = new HouseholdStore(database)
    const key = randomBytes(32).toString('base64url')
    const owner = identities.setup({ requestId: randomUUID(), displayName: 'Owner', deviceName: 'Phone', deviceSecret: key,
      currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
    const now = Date.now()
    for (const state of ['held', 'committed']) {
      const reviewId = randomUUID(), operationId = randomUUID()
      database.prepare(`INSERT INTO household_arrangement_reviews
        (id, household_id, creator_account_id, request_hash, payload, created_at, expires_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(reviewId, owner.householdId, owner.accountId, 'original-hash', '{}', now, now + 60_000, 'open')
      database.prepare(`INSERT INTO household_arrangement_transitions
        (id, household_id, review_id, account_id, device_id, request_hash, request, run_id,
        admission_revision, state, created_at, context, recovery)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(operationId, owner.householdId, reviewId, owner.accountId,
        identities.deviceIdentity(key), 'original-hash', '{}', randomUUID(), 2, state, now, '{}', state === 'committed' ? 'saved-recovery-evidence' : null)
      if (state === 'held') database.prepare('UPDATE hardware_admission SET revision = 2, hold_id = ?, held_at = ?').run(operationId, now)
    }
    const tables = ['households', 'household_accounts', 'household_devices', 'household_personal_settings',
      'household_arrangement_reviews', 'hardware_admission']
    const preserved = tables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = database.prepare('SELECT * FROM household_arrangement_transitions ORDER BY rowid').all()
    migrate(drizzle(database), { migrationsFolder: current })
    expect(database.prepare('SELECT * FROM household_arrangement_transitions ORDER BY rowid').all())
      .toEqual(lastMigration === 65 ? before.map(row => ({ ...row as Record<string, unknown>, cancellation: null })) : before)
    expect(tables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(preserved)
    expect(database.prepare('SELECT * FROM household_arrangement_restarts').all()).toEqual([])
    const operationIds = before.map(row => (row as { id: string }).id)
    const requestId = randomUUID()
    const insert = database.prepare(`INSERT INTO household_arrangement_restarts
      (operation_id, request_id, request_hash, request, controller, receipt) VALUES (?, ?, ?, ?, ?, ?)`)
    insert.run(operationIds[0], requestId, 'saved-hash', '{}', '{}', 'saved-restart-receipt')
    expect(() => insert.run(operationIds[1], requestId, 'saved-hash', '{}', '{}', '{}')).toThrow(/UNIQUE/)
    expect(() => insert.run(randomUUID(), randomUUID(), 'saved-hash', '{}', '{}', '{}')).toThrow(/FOREIGN KEY/)
    const restartBefore = database.prepare('SELECT * FROM household_arrangement_restarts').all()
    expect(database.pragma('foreign_key_check')).toEqual([])
    expect(() => migrate(drizzle(database), { migrationsFolder: current })).not.toThrow()
    expect(database.prepare('SELECT * FROM household_arrangement_restarts').all()).toEqual(restartBefore)
  }
  finally {
    database.close()
    rmSync(previous, { recursive: true, force: true })
  }
})
