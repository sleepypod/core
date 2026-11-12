import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { HouseholdQuietStore } from '../quiet'
import { HouseholdStore } from '../store'

const holder = vi.hoisted(() => ({ database: null as Database.Database | null }))
vi.mock('@/src/db', () => ({ get sqlite() {
  return holder.database
} }))
const { assertSharedBaseMovementAllowed, getHouseholdQuiet } = await import('../quietRuntime')
const globals = globalThis as typeof globalThis & { __sleepypodHouseholdQuiet?: HouseholdQuietStore }
let database: Database.Database, directory: string
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(Date.parse('2026-11-12T07:00:00Z'))
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-quiet-runtime-'))
  database = migratedComfortDatabase(join(directory, 'configuration.db'))
  holder.database = database
  delete globals.__sleepypodHouseholdQuiet
})
afterEach(() => {
  delete globals.__sleepypodHouseholdQuiet
  holder.database = null
  database.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

it('allows an installation without household requests and reuses the shared store', () => {
  expect(() => assertSharedBaseMovementAllowed()).not.toThrow()
  expect(getHouseholdQuiet()).toBe(getHouseholdQuiet())
})

it('reads another worker’s committed quiet request at every movement boundary', () => {
  const identities = new HouseholdStore(database)
  const credential = randomBytes(32).toString('base64url')
  identities.setup({ requestId: randomUUID(), displayName: 'Example owner', deviceName: 'Phone', deviceSecret: credential,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const writer = new HouseholdQuietStore(database, identities)
  expect(() => assertSharedBaseMovementAllowed()).not.toThrow()
  const now = Date.now()
  writer.write(credential, { requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1,
    expectedRevision: null, issuedAt: now, expiresAt: now + 30_000, until: now + 1000 })
  expect(() => assertSharedBaseMovementAllowed()).toThrow('while someone is resting')
  vi.advanceTimersByTime(1000)
  expect(() => assertSharedBaseMovementAllowed()).not.toThrow()
})

it('withdraws movement permission when configuration or quiet storage cannot be read', () => {
  database.exec('DROP TABLE household_quiet_requests')
  expect(() => assertSharedBaseMovementAllowed()).toThrow('Quiet status is unavailable')
  expect(getHouseholdQuiet().telemetry()).toMatchObject({ available: false, paused: null })
})
