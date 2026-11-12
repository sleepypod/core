import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { HouseholdStore } from '../store'
import { HouseholdQuietStore } from '../quiet'
import { QUIET_MAX_DURATION_MS, quietWriteSchema } from '../quietContract'

let database: Database.Database, identities: HouseholdStore, quiet: HouseholdQuietStore
let now: number, owner: string, member: string, directory: string
const secret = () => randomBytes(32).toString('base64url')
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
const request = (until: number | null = now + 3_600_000, expectedRevision: string | null = null) =>
  ({ ...context(), issuedAt: now, expiresAt: now + 30_000, expectedRevision, until })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-household-quiet-'))
  database = migratedComfortDatabase(join(directory, 'configuration.db'))
  now = Date.parse('2026-11-12T07:00:00Z')
  identities = new HouseholdStore(database, () => now)
  owner = secret()
  member = secret()
  identities.setup({ requestId: randomUUID(), displayName: 'Example owner', deviceName: 'Phone', deviceSecret: owner,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(owner, { ...context(), kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, displayName: 'Example member', deviceName: 'Tablet', deviceSecret: member })
  quiet = new HouseholdQuietStore(database, identities, () => now)
})
afterEach(() => {
  database.close()
  rmSync(directory, { recursive: true, force: true })
})

it('allows either account to request rest without assigning a physical side', () => {
  expect(quiet.read(owner)).toEqual({ mine: { revision: null, until: null }, shared: { paused: false, until: null } })
  const until = now + 3_600_000, saved = quiet.write(member, request(until))
  expect(identities.session(member).self.zones).toEqual([])
  expect(quiet.read(owner)).toEqual({ mine: { revision: null, until: null }, shared: { paused: true, until } })
  expect(quiet.read(member).mine).toEqual({ revision: saved.revision, until })
})

it('preserves the other person’s request when one person clears or shortens theirs', () => {
  const ownerSave = quiet.write(owner, request(now + 7_200_000))
  const memberSave = quiet.write(member, request(now + 3_600_000))
  const shortened = quiet.write(owner, request(now + 60_000, ownerSave.revision))
  expect(quiet.sharedState()).toEqual({ paused: true, until: now + 3_600_000 })
  quiet.write(owner, request(null, shortened.revision))
  expect(quiet.sharedState()).toEqual({ paused: true, until: now + 3_600_000 })
  expect(quiet.read(member).mine.revision).toBe(memberSave.revision)
  quiet.write(member, request(null, memberSave.revision))
  expect(quiet.sharedState()).toEqual({ paused: false, until: null })
})

it('uses absolute expiry across restart and daylight-saving changes without a cleanup timer', () => {
  now = Date.parse('2026-11-01T08:30:00Z')
  const until = now + 7_200_000, input = request(until), saved = quiet.write(owner, input)
  now = until - 1
  const restarted = new HouseholdQuietStore(database, new HouseholdStore(database, () => now), () => now)
  expect(restarted.sharedState()).toEqual({ paused: true, until })
  now = until
  expect(restarted.read(owner)).toEqual({ mine: { revision: saved.revision, until: null }, shared: { paused: false, until: null } })
  expect(restarted.write(owner, input)).toEqual(saved)
  expect(restarted.sharedState().paused).toBe(false)
})

it('never reactivates a cleared request when a delayed retry arrives', () => {
  const input = request(), saved = quiet.write(owner, input)
  const cleared = quiet.write(owner, request(null, saved.revision))
  now += 60_000
  expect(quiet.write(owner, input)).toEqual(saved)
  expect(quiet.read(owner)).toEqual({ mine: { revision: cleared.revision, until: null }, shared: { paused: false, until: null } })
  expect(quiet.receipt(owner, input.requestId)).toEqual(saved)
  expect(quiet.receipt(member, input.requestId)).toBeNull()
})

it('rejects altered, cross-account and conflicting requests without replacing either intent', () => {
  const input = request(), saved = quiet.write(owner, input)
  expect(() => quiet.write(owner, { ...input, until: now + 3_601_000 })).toThrow('identifier')
  expect(() => quiet.write(member, input)).toThrow('identifier')
  expect(() => quiet.write(owner, request())).toThrow('another device')
  expect(() => quiet.write(owner, { ...request(null, saved.revision), expectedSessionRevision: 2 })).toThrow('account')
  expect(() => quiet.write(owner, { ...request(null, saved.revision), expectedAssignmentRevision: 2 })).toThrow('assignment')
  expect(quiet.read(owner).mine.revision).toBe(saved.revision)
})

it('does not authorize a stale device or transfer quiet ownership when physical assignments change', () => {
  const saved = quiet.write(owner, request())
  database.prepare('UPDATE households SET mode = ?, assignment_revision = assignment_revision + 1').run('assigned')
  database.prepare('UPDATE household_accounts SET assigned_side = ? WHERE id = ?').run('right', identities.session(owner).accountId)
  expect(quiet.read(owner).mine.revision).toBe(saved.revision)
  expect(quiet.read(member).mine.revision).toBeNull()
  expect(() => quiet.write(owner, request(null, saved.revision))).toThrow('assignment')
  database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(now, identities.session(owner).accountId)
  expect(() => quiet.read(owner)).toThrow()
  // Existing bounded rest is retained even when its author loses device access.
  expect(quiet.sharedState().paused).toBe(true)
})

it.each(['expired', 'future', 'past_end', 'too_long'] as const)('rejects a %s request before writing intent or receipt', (kind) => {
  const input = request()
  if (kind === 'expired') {
    input.issuedAt -= 60_000
    input.expiresAt = now
  }
  if (kind === 'future') {
    input.issuedAt += 5_001
    input.expiresAt += 5_001
  }
  if (kind === 'past_end') {
    input.issuedAt -= 30_000
    input.until = now
    input.expiresAt = now + 1000
  }
  if (kind === 'too_long') input.until = now + QUIET_MAX_DURATION_MS + 1
  expect(() => quiet.write(owner, input)).toThrow()
  expect(quiet.read(owner).mine.revision).toBeNull()
  expect(database.prepare('SELECT COUNT(*) AS count FROM household_mutation_receipts WHERE kind = ?').get('household_quiet')).toEqual({ count: 0 })
})

it('withdraws shared permission on clock rollback, unreadable state or malformed persisted rows', () => {
  const input = request()
  quiet.write(owner, input)
  now -= 1
  expect(quiet.telemetry()).toMatchObject({ available: false, paused: null, expiresAt: null })
  expect(() => quiet.write(member, request())).toThrow('unavailable')
  now += 1
  database.prepare('UPDATE household_quiet_requests SET quiet_until = ?').run(now + QUIET_MAX_DURATION_MS + 1)
  expect(() => quiet.sharedState()).toThrow('unavailable')
  expect(quiet.telemetry().available).toBe(false)
  database.exec('DROP TABLE household_quiet_requests')
  expect(quiet.telemetry().available).toBe(false)
})

it('publishes only a short-lived shared boolean and end, without identities or private records', () => {
  quiet.write(member, request())
  const telemetry = quiet.telemetry()
  expect(telemetry).toEqual({ schemaVersion: 1, source: 'household_quiet', available: true,
    ts: now, expiresAt: now + 15_000, paused: true, until: now + 3_600_000 })
  const serialized = JSON.stringify(telemetry)
  for (const value of [owner, member, identities.session(owner).accountId, identities.session(member).selfSleeperId, 'Example member'])
    expect(serialized).not.toContain(value)
})

it('preserves all schedules, assignments, preferences and learning while saving and clearing quiet', () => {
  const tables = ['households', 'household_accounts', 'household_personal_settings', 'bedtime_routines', 'alarm_schedules',
    'household_learning_records', 'comfort_feedback', 'comfort_states', 'comfort_models', 'control_receipts']
  const snapshot = () => tables.map(table => database.prepare(`SELECT * FROM ${table}`).all())
  const before = snapshot(), saved = quiet.write(member, request())
  quiet.write(member, request(null, saved.revision))
  expect(snapshot()).toEqual(before)
})

it('rejects side/account selectors and indefinite or oversized requests', () => {
  for (const extra of [{ accountId: identities.session(member).accountId }, { side: 'right' }, { duration: 'forever' }, { expiresAt: now + 60_001 }])
    expect(quietWriteSchema.safeParse({ ...request(), ...extra }).success).toBe(false)
})
