// @vitest-environment node
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, cpSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { personalRuntimeFixture } from './runtimeFixture'
import { legacyPrivacyState, legacyPrivacyDenial } from '../legacyPrivacy'
import { requireAccess, authorized, legacyStreamAuthorized } from '@/src/auth/access'
import { privateApiResponse } from '@/src/auth/privateResponse'
import { GET as authStatus, POST as ownerLogin } from '@/app/api/auth/session/route'

const token = 'test-only-legacy-owner-connection-key'
let directory: string
let fixture: ReturnType<typeof personalRuntimeFixture>
let path: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-privacy-boundary-'))
  path = join(directory, 'configuration.db')
  fixture = personalRuntimeFixture(path)
  vi.stubEnv('DATABASE_URL', path)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', token)
})
afterEach(() => {
  fixture.database.close()
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
const ownerHeaders = () => new Headers({ Authorization: `Bearer ${token}` })
const request = (route = '/api/status') => new Request(`http://pod${route}`, { headers: ownerHeaders() })

it('keeps preparation and unassigned drafts separate from activating a private bed', () => {
  expect(fixture.identities.session(fixture.memberKey).self.zones).toEqual([])
  expect(legacyPrivacyState()).toBe('legacy')
  expect(requireAccess(request())).toBeNull()
  expect(legacyStreamAuthorized(ownerHeaders())).toBe(true)
})

it('persists through side reversal, member revocation, feature flags, and process reconnection', () => {
  fixture.assignedFixture()
  expect(legacyPrivacyState()).toBe('personal_required')
  fixture.database.exec('UPDATE households SET mode = \'solo-anywhere\'; UPDATE household_accounts SET assigned_side = NULL; UPDATE household_accounts SET state = \'revoked\' WHERE role = \'member\'')
  vi.stubEnv('SLEEPYPOD_HOUSEHOLD_PREPARATION', '0')
  vi.stubEnv('SLEEPYPOD_PERSONAL_RUNTIME', '0')
  expect(legacyPrivacyState(path)).toBe('personal_required')
  expect(() => fixture.database.exec('DELETE FROM household_privacy_boundary')).toThrow('cannot be removed')
  expect(() => fixture.database.exec('UPDATE household_privacy_boundary SET reason = \'reset\'')).toThrow('cannot be changed')
  expect(fixture.identities.session(fixture.ownerKey).selfSleeperId).toBe(fixture.owner.selfSleeperId)
})

it.each(['/api/settings', '/api/trpc', '/api/trpc/history.get', '/api/v1/capabilities', '/api/raw/night.RAW', '/api/export/archive', '/api/db-backup', '/api/mcp', '/api/biometrics/watch-upload', '/panel'])('rejects the old owner authority at %s without rejecting personal account administration', async (route) => {
  fixture.assignedFixture()
  expect(authorized(ownerHeaders())).toBe(true)
  const denied = requireAccess(request(route))
  expect(denied?.status).toBe(403)
  expect(await denied?.json()).toMatchObject({ code: 'personal_connection_required' })
  expect(legacyStreamAuthorized(ownerHeaders())).toBe(false)
  expect(requireAccess(new Request(`http://pod${route}`))?.status).toBe(401)
})

it('rejects in-flight private responses before and during delivery when assignment activates', async () => {
  const stream = privateApiResponse(request(), new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new TextEncoder().encode('private chunk')) },
  })))
  if (!stream.body) throw new Error('Expected private response body')
  const reader = stream.body.getReader()
  expect((await reader.read()).value).toBeDefined()
  fixture.assignedFixture()
  await expect(reader.read()).rejects.toThrow('access')
  const delayed = privateApiResponse(request(), new Response('another sleeper'))
  expect(delayed.status).toBe(403)
  expect(await delayed.text()).not.toContain('another sleeper')
})

it('directs owner browsers to a personal connection without issuing another broad cookie', async () => {
  fixture.assignedFixture()
  expect(await authStatus(request('/api/auth/session')).json()).toMatchObject({ authenticated: false, personalConnectionRequired: true, privacyAvailable: true })
  const response = await ownerLogin(new Request('http://pod/api/auth/session', { method: 'POST',
    headers: { 'host': 'pod', 'origin': 'http://pod', 'content-type': 'application/json' }, body: JSON.stringify({ token, exitPersonalSession: true }) }))
  expect(response.status).toBe(403)
  expect(response.headers.get('set-cookie')).toBeNull()
})

it('rolls the boundary back with a failed assignment transaction', () => {
  expect(() => fixture.database.transaction(() => {
    fixture.assignedFixture()
    throw new Error('save failed')
  })()).toThrow('save failed')
  expect(legacyPrivacyState()).toBe('legacy')
})

it('activates for an attribution epoch even before physical assignment changes', () => {
  fixture.database.prepare(`INSERT INTO household_attribution_epochs
    (id, household_id, dataset_id, starts_at, mode, assignments, basis, review_receipt_id, reviewed_by, request_hash, created_at)
    VALUES (?, ?, 'test-dataset', 1000, 'assigned', '[]', 'verified_arrangement', ?, ?, 'test', 1000)`)
    .run(randomUUID(), fixture.owner.householdId, randomUUID(), fixture.owner.accountId)
  expect(legacyPrivacyState()).toBe('personal_required')
})

it('fails closed for a missing, broken or partially migrated database', async () => {
  for (const destination of [join(directory, 'missing.db'), join(directory, 'broken.db'), join(directory, 'partial.db')]) {
    if (destination.endsWith('broken.db')) writeFileSync(destination, 'not a database')
    if (destination.endsWith('partial.db')) {
      const partial = new Database(destination)
      partial.exec('CREATE TABLE household_accounts (id TEXT)')
      partial.close()
    }
    vi.stubEnv('DATABASE_URL', destination)
    expect(legacyPrivacyState()).toBe('unavailable')
    expect(legacyPrivacyDenial()?.status).toBe(503)
    expect(requireAccess(request())?.status).toBe(503)
    expect(legacyStreamAuthorized(ownerHeaders())).toBe(false)
    expect(await authStatus(request()).json()).toMatchObject({ authenticated: false, privacyAvailable: false })
  }
})

it('does not treat an empty older database as another person having joined', () => {
  const oldPath = join(directory, 'old.db')
  new Database(oldPath).close()
  expect(legacyPrivacyState(oldPath)).toBe('legacy')
})

it('backfills a pre-boundary shared installation during migration', () => {
  const migrations = join(directory, 'migrations')
  cpSync(resolve('src/db/migrations'), migrations, { recursive: true })
  const journalPath = join(migrations, 'meta/_journal.json')
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] }
  journal.entries = journal.entries.filter(entry => entry.idx <= 50)
  writeFileSync(journalPath, JSON.stringify(journal))
  const legacy = new Database(join(directory, 'upgrade.db'))
  try {
    migrate(drizzle(legacy), { migrationsFolder: migrations })
    legacy.prepare('INSERT INTO households VALUES (\'household\', \'pod\', \'setup\', 1, 2, \'assigned\', \'left\', 1000)').run()
    migrate(drizzle(legacy), { migrationsFolder: resolve('src/db/migrations') })
    expect(legacy.prepare('SELECT reason FROM household_privacy_boundary').get()).toEqual({ reason: 'existing_personal_arrangement' })
    legacy.exec('UPDATE households SET mode = \'solo-anywhere\'')
    expect(legacyPrivacyState(join(directory, 'upgrade.db'))).toBe('personal_required')
  }
  finally { legacy.close() }
})
