import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { bindBrowserScope } from '@/src/auth/browserScope'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { HouseholdStore } from '../store'
import { HouseholdQuietStore } from '../quiet'
import { HouseholdQuietApi } from '../quietApi'
import { quietReadResponseSchema, quietWriteResponseSchema, sharedQuietReadSchema } from '../quietContract'
import { householdHttp, type HouseholdHttpDependencies } from '../http'

let database: Database.Database, identities: HouseholdStore, quiet: HouseholdQuietStore, dependencies: HouseholdHttpDependencies
let now: number, directory: string, owner: string, member: string, legacy: string
const secret = () => randomBytes(32).toString('base64url')
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
const input = () => ({ ...context(), issuedAt: now, expiresAt: now + 30_000, expectedRevision: null, until: now + 3_600_000 })
function request(path = 'me/quiet', method = 'GET', body?: unknown, key: string | null = owner, headers: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/${path}`, { method, headers: { host: 'pod.test',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function cookie(key: string) {
  const session = issuePersonalSession(identities.deviceIdentity(key))
  const binding = bindBrowserScope(request('household/session'), 'personal', session).split(';')[0]
  return `${PERSONAL_COOKIE}=${session}; ${binding}`
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-household-quiet-http-'))
  const filename = join(directory, 'configuration.db')
  database = migratedComfortDatabase(filename)
  vi.stubEnv('DATABASE_URL', filename)
  now = Date.parse('2026-11-12T07:00:00Z')
  owner = secret()
  member = secret()
  legacy = secret()
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', legacy)
  identities = new HouseholdStore(database, () => now)
  identities.setup({ requestId: randomUUID(), displayName: 'Example owner', deviceName: 'Phone', deviceSecret: owner,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(owner, { ...context(), kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, displayName: 'Example member', deviceName: 'Tablet', deviceSecret: member })
  quiet = new HouseholdQuietStore(database, identities, () => now)
  dependencies = { store: identities, verifySoloConfiguration: () => true,
    householdQuiet: new HouseholdQuietApi({ identities, quiet, now: () => now }) }
})
afterEach(() => {
  database.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('advertises quiet and scopes save/read/receipt to the authenticated person', async () => {
  const session = await householdHttp(request('household/session'), dependencies)
  expect((await session.json()).capabilities.householdQuiet).toBe(true)
  const change = input(), saved = await householdHttp(request('me/quiet', 'POST', change), dependencies)
  const result = quietWriteResponseSchema.parse(await saved.json())
  expect(result.scope.accountId).toBe(identities.session(owner).accountId)
  const response = await householdHttp(request(), dependencies)
  const state = quietReadResponseSchema.parse(await response.json())
  expect(state.mine.revision).toBe(result.receipt?.revision)
  expect(state.shared).toEqual({ paused: true, until: change.until })
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect(response.headers.get('vary')).toContain('X-Sleepypod-Sleeper-Id')
  const other = await householdHttp(request(`me/quiet/requests/${change.requestId}`, 'GET', undefined, member), dependencies)
  expect((await other.json()).receipt).toBeNull()
})

it('rejects owner installation keys, unknown keys, cross-origin requests and extra query selectors', async () => {
  const browser = cookie(owner)
  for (const key of [legacy, secret()])
    expect((await householdHttp(request('me/quiet', 'POST', input(), key, { cookie: browser }), dependencies)).status).toBe(401)
  expect((await householdHttp(request('me/quiet', 'POST', input(), owner, { origin: 'https://another.test' }), dependencies)).status).toBe(403)
  expect((await householdHttp(request('me/quiet?side=left'), dependencies)).status).toBe(400)
  expect(quiet.sharedState().paused).toBe(false)
})

it('requires the pinned browser person and rejects stale tabs after account switching', async () => {
  const browser = cookie(owner)
  for (const method of ['GET', 'POST']) {
    const body = method === 'POST' ? input() : undefined
    expect((await householdHttp(request('me/quiet', method, body, null, { cookie: browser, origin: 'http://pod.test' }), dependencies)).status).toBe(409)
    expect((await householdHttp(request('me/quiet', method, body, null, { 'cookie': browser, 'origin': 'http://pod.test',
      'x-sleepypod-sleeper-id': identities.session(member).selfSleeperId }), dependencies)).status).toBe(409)
    const result = await householdHttp(request('me/quiet', method, body, null, { 'cookie': browser, 'origin': 'http://pod.test',
      'x-sleepypod-sleeper-id': identities.session(owner).selfSleeperId }), dependencies)
    expect(result.status).toBe(200)
    await result.json()
  }
})

it('withholds a read when another person changes shared quiet before response delivery', async () => {
  const response = await householdHttp(request(), dependencies)
  quiet.write(member, input())
  await expect(response.json()).rejects.toThrow('changed before delivery')
})

it('withholds a saved receipt after revocation without repeating or undoing the committed request', async () => {
  const change = input(), response = await householdHttp(request('me/quiet', 'POST', change), dependencies)
  database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(now, identities.session(owner).accountId)
  await expect(response.json()).rejects.toThrow('changed before delivery')
  expect(quiet.sharedState()).toEqual({ paused: true, until: change.until })
  expect(database.prepare('SELECT COUNT(*) AS count FROM household_quiet_requests').get()).toEqual({ count: 1 })
})

it('withholds a status that expires before delivery and reports damaged storage as unavailable', async () => {
  quiet.write(owner, { ...input(), until: now + 1000 })
  const response = await householdHttp(request(), dependencies)
  now += 1000
  await expect(response.json()).rejects.toThrow('changed before delivery')
  database.prepare('UPDATE household_quiet_requests SET revision = ?').run('invalid')
  expect((await householdHttp(request(), dependencies)).status).toBe(503)
})

it('lets the installation read only the union of shared quiet requests without household identities', async () => {
  quiet.write(member, input())
  const response = await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy), dependencies)
  expect(response.status).toBe(200)
  const body = sharedQuietReadSchema.parse(await response.json())
  expect(body).toEqual({ version: 1, generatedAt: now, expiresAt: now + 15_000, shared: { paused: true, until: now + 3_600_000 } })
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(JSON.stringify(body)).not.toContain(identities.session(member).accountId)
  expect(JSON.stringify(body)).not.toContain('Example member')
})

it('rejects missing, personal and unknown owner credentials and cross-origin shared reads', async () => {
  for (const key of [null, owner, member, secret()]) {
    const response = await householdHttp(request('household/shared-quiet', 'GET', undefined, key), dependencies)
    expect(response.status).toBe(403)
  }
  expect((await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy, { origin: 'https://other.test' }), dependencies)).status).toBe(403)
})

it('does not let owner audio reads become writes or arbitrary personal selectors', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    expect((await householdHttp(request('household/shared-quiet', method, input(), legacy), dependencies)).status).toBe(400)
  }
  expect((await householdHttp(request('household/shared-quiet?account=other', 'GET', undefined, legacy), dependencies)).status).toBe(400)
  expect(quiet.sharedState()).toEqual({ paused: false, until: null })
})

it('withdraws an owner reading if a quiet request or its credentials change before delivery', async () => {
  const changedQuiet = await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy), dependencies)
  quiet.write(member, input())
  await expect(changedQuiet.json()).rejects.toThrow('changed before delivery')
  const changedOwner = await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy), dependencies)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', secret())
  await expect(changedOwner.json()).rejects.toThrow('changed before delivery')
})

it.each([15_000, -1])('withdraws a shared reading on expiry or reversed controller clock (%i)', async (advance) => {
  const response = await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy), dependencies)
  now += advance
  await expect(response.json()).rejects.toThrow('changed before delivery')
})

it('does not clear quiet time when storage is damaged or the shared service is missing', async () => {
  quiet.write(member, input())
  database.prepare('UPDATE household_quiet_requests SET revision = ?').run('damaged')
  expect((await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy), dependencies)).status).toBe(503)
  const withoutQuiet = { ...dependencies, householdQuiet: undefined }
  expect((await householdHttp(request('household/shared-quiet', 'GET', undefined, legacy), withoutQuiet)).status).toBe(503)
})
