import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { authorized } from '@/src/auth/access'
import { GET as ownerStatus, POST as ownerLogin } from '@/app/api/auth/session/route'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { HouseholdStore } from '../store'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { issuePersonalSession, personalCredential, PERSONAL_COOKIE, PERSONAL_SESSION_SECONDS } from '../browserSession'
import { householdBackupRestricted } from '../privacy'
import * as contract from '../contract'
import fixtures from '../fixtures/preparation-v1.json'
let database: Database.Database, store: HouseholdStore, dependencies: HouseholdHttpDependencies
let owner: string, personal: string, member: string
let directory: string
const secret = () => randomBytes(32).toString('base64url')
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
function request(path: string, method = 'GET', body?: unknown, key?: string, headers: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/${path}`, { method, headers: { host: 'pod.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function personalCookies(value: string) {
  const scope = bindBrowserScope(request('household/session'), 'personal', value).split(';')[0]
  return `${PERSONAL_COOKIE}=${value}; ${scope}`
}
beforeEach(() => {
  owner = secret()
  personal = secret()
  member = secret()
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', owner)
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-household-test-'))
  const databasePath = join(directory, 'configuration.db')
  database = migratedComfortDatabase(databasePath)
  vi.stubEnv('DATABASE_URL', databasePath)
  store = new HouseholdStore(database)
  dependencies = { store, verifySoloConfiguration: () => true }
  store.setup({ requestId: randomUUID(), displayName: 'Owner', deviceName: 'Owner phone', deviceSecret: personal, currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = store.createInvitation(personal, { ...context(), kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  store.join({ invitation: invitation.invitation, displayName: 'Member', deviceName: 'Member phone', deviceSecret: member })
})
afterEach(() => {
  database.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})
it('freezes shared native/web response fixtures with explicit draft-only and unavailable capability states', () => {
  contract.householdSessionSchema.parse(fixtures.ownerSession)
  contract.householdSessionSchema.parse(fixtures.memberSession)
  contract.personalPreferencesResponseSchema.parse(fixtures.preferences)
  contract.personalRoutinesResponseSchema.parse(fixtures.routines)
  contract.deviceResponseSchema.parse(fixtures.devices)
  contract.invitationsResponseSchema.parse(fixtures.invitations)
  contract.revokedResponseSchema.parse(fixtures.revoked)
  contract.householdErrorSchema.parse(fixtures.conflict)
})
it('denies existing owner credentials at personal endpoints and personal credentials at legacy authorization', async () => {
  expect((await householdHttp(request('me/preferences', 'GET', undefined, owner), dependencies)).status).toBe(401)
  expect(authorized(new Headers({ authorization: `Bearer ${member}` }))).toBe(false)
  expect(authorized(new Headers({ cookie: `${PERSONAL_COOKIE}=${issuePersonalSession(store.deviceIdentity(member))}` }))).toBe(false)
  const response = await householdHttp(request('me/preferences', 'GET', undefined, member), dependencies)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toContain('no-store')
  expect((await response.json()).sleeperId).toBe(store.session(member).selfSleeperId)
})
it('requires legacy owner authority and current solo/follow setup before household preparation', async () => {
  const input = { requestId: randomUUID(), displayName: 'Owner', deviceName: 'Owner phone', deviceSecret: personal, currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true }
  expect((await householdHttp(request('household/setup', 'POST', input, member), dependencies)).status).toBe(403)
  expect((await householdHttp(request('household/setup', 'POST', input, owner), { ...dependencies, verifySoloConfiguration: () => false })).status).toBe(409)
})
it('creates a signed browser session with no reusable key and clears legacy owner cookies', async () => {
  const response = await householdHttp(request('household/session', 'POST', { token: member }, undefined, { origin: 'http://pod.test' }), dependencies)
  expect(response.status).toBe(200)
  const cookies = response.headers.getSetCookie()
  expect(cookies).toHaveLength(3)
  expect(cookies.join()).not.toContain(member)
  expect(cookies[0]).toContain('HttpOnly; SameSite=Strict')
  expect(cookies[0]).toContain('; Path=/;')
  expect(cookies[2]).toContain('sleepypod_session=;')
  const cookie = cookies.slice(0, 2).map(value => value.split(';')[0]).join('; ')
  const read = request('me/preferences', 'GET', undefined, undefined, { cookie })
  expect((await householdHttp(read, dependencies)).status).toBe(200)
  const write = request('me/preferences', 'PUT', { ...context(), expectedRevision: 1, preferences: fixtures.preferences.preferences }, undefined, { cookie })
  expect((await householdHttp(write, dependencies)).status).toBe(403)
})
it('requires same-origin requests, rejects duplicate cookies and does not fall back after an invalid Bearer', async () => {
  const cookie = personalCookies(issuePersonalSession(store.deviceIdentity(member)))
  expect((await householdHttp(request('me/preferences', 'GET', undefined, member, { origin: 'https://outside.test' }), dependencies)).status).toBe(403)
  expect((await householdHttp(request('me/preferences', 'GET', undefined, secret(), { cookie }), dependencies)).status).toBe(401)
  expect((await householdHttp(request('me/preferences', 'GET', undefined, undefined, { cookie: `${cookie}; ${cookie}` }), dependencies)).status).toBe(401)
})
it('rejects stale browser editors after another tab changes the selected sleeper', async () => {
  const cookie = personalCookies(issuePersonalSession(store.deviceIdentity(member)))
  const mutation = { ...context(), expectedRevision: 1, preferences: fixtures.preferences.preferences }
  const headers = { cookie, origin: 'http://pod.test' }
  const missingScope = await householdHttp(request('me/preferences', 'PUT', mutation, undefined, headers), dependencies)
  expect(missingScope.status).toBe(409)
  const staleScope = await householdHttp(request('me/preferences', 'PUT', mutation, undefined, { ...headers, 'x-sleepypod-sleeper-id': store.session(personal).selfSleeperId }), dependencies)
  expect(staleScope.status).toBe(409)
  expect(store.preferences(member).revision).toBe(1)
  const currentScope = await householdHttp(request('me/preferences', 'PUT', mutation, undefined, { ...headers, 'x-sleepypod-sleeper-id': store.session(member).selfSleeperId }), dependencies)
  expect(currentScope.status).toBe(200)
})
it('expires and invalidates signed cookies on key rotation or device revocation', () => {
  const now = Date.now(), token = issuePersonalSession(store.deviceIdentity(member), now)
  const incoming = request('me/preferences', 'GET', undefined, undefined, { cookie: personalCookies(token) })
  expect(personalCredential(incoming, now)).toEqual({ deviceId: store.deviceIdentity(member) })
  expect(() => personalCredential(incoming, now + PERSONAL_SESSION_SECONDS * 1000)).toThrow('expired')
  expect(() => personalCredential(incoming, now - 1000)).toThrow('expired')
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', secret())
  expect(() => personalCredential(incoming, now)).toThrow('Reconnect')
})
it('rejects oversized/chunked bodies, extra scope fields and unsupported operations without echoing input', async () => {
  const tooLarge = request('household/join', 'POST', { invitation: 'private input '.repeat(15000) })
  const oversized = await householdHttp(tooLarge, dependencies)
  expect(oversized.status).toBe(413)
  expect(await oversized.text()).not.toContain('private input')
  const crossAccount = { ...context(), expectedRevision: 1, preferences: fixtures.preferences.preferences, sleeperId: store.session(personal).selfSleeperId }
  expect((await householdHttp(request('me/preferences', 'PUT', crossAccount, member), dependencies)).status).toBe(400)
  expect((await householdHttp(request('me/watch-references', 'POST', {}, member), dependencies)).status).toBe(404)
  expect((await householdHttp(request('household/join', 'POST', {}, undefined), { ...dependencies, allowPublicAttempt: () => false })).status).toBe(429)
})
it('keeps whole-database exports unavailable while household preparation is enabled even before first signup', () => {
  vi.stubEnv('SLEEPYPOD_HOUSEHOLD_PREPARATION', '1')
  expect(householdBackupRestricted('/does/not/exist')).toBe(true)
})
it('clears personal browser sessions without weakening logout origin protection', async () => {
  expect((await householdHttp(request('household/session', 'DELETE'), dependencies)).status).toBe(403)
  const response = await householdHttp(request('household/session', 'DELETE', undefined, undefined, { origin: 'http://pod.test' }), dependencies)
  expect(response.status).toBe(204)
  expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
  expect(response.headers.getSetCookie()).toHaveLength(2)
  expect(response.headers.getSetCookie()[1]).toContain('sleepypod_session=;')
})

it('rejects a delayed explicit owner response after a newer personal connection and after logout', async () => {
  const cookieJar = new Map<string, string>()
  const apply = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [name, ...value] = cookie.split(';')[0].split('=')
      if (cookie.includes('Max-Age=0')) cookieJar.delete(name)
      else cookieJar.set(name, value.join('='))
    }
  }
  const headers = () => {
    const cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ')
    return { 'origin': 'http://pod.test', cookie, 'x-sleepypod-browser-revision': browserScopeRevision(new Headers({ cookie })) ?? '' }
  }
  const connectPersonal = () => householdHttp(request('household/session', 'POST', { token: member }, undefined, headers()), dependencies)
  apply(await connectPersonal())
  const staleRequestHeaders = { ...headers(), 'host': 'pod.test', 'content-type': 'application/json' }
  const earlierOwnerResponse = await ownerLogin(new Request('http://pod.test/api/auth/session', { method: 'POST', headers: { ...headers(), 'host': 'pod.test', 'content-type': 'application/json' }, body: JSON.stringify({ token: owner, exitPersonalSession: true }) }))
  expect(earlierOwnerResponse.status).toBe(200)
  const newerPersonalResponse = await connectPersonal()
  expect(newerPersonalResponse.status).toBe(200)
  apply(newerPersonalResponse)
  const delayedOwnerRequest = await ownerLogin(new Request('http://pod.test/api/auth/session', { method: 'POST', headers: staleRequestHeaders, body: JSON.stringify({ token: owner, exitPersonalSession: true }) }))
  expect(delayedOwnerRequest.status).toBe(409)
  apply(earlierOwnerResponse)
  const staleHeaders = new Headers({ host: 'pod.test', ...headers() })
  expect(authorized(staleHeaders)).toBe(false)
  const strippedScope = new Headers({ host: 'pod.test', cookie: `sleepypod_session=${cookieJar.get('sleepypod_session')}` })
  expect(authorized(strippedScope)).toBe(false)
  expect(await ownerStatus(new Request('http://pod.test/api/auth/session', { headers: staleHeaders })).json()).toMatchObject({ authenticated: false, personalSessionActive: true })
  expect((await householdHttp(request('me/preferences', 'GET', undefined, undefined, headers()), dependencies)).status).toBe(401)
  // A fresh personal connection recovers; replaying its cookies after logout cannot.
  const recovered = await connectPersonal()
  apply(recovered)
  expect((await householdHttp(request('me/preferences', 'GET', undefined, undefined, headers()), dependencies)).status).toBe(200)
  const logout = await householdHttp(request('household/session', 'DELETE', undefined, undefined, headers()), dependencies)
  expect(logout.status).toBe(204)
  apply(logout)
  apply(recovered)
  expect((await householdHttp(request('me/preferences', 'GET', undefined, undefined, headers()), dependencies)).status).toBe(401)
})

it('rolls back a device join and invitation claim when browser scope admission conflicts', async () => {
  const invitation = store.createInvitation(member, { ...context(), kind: 'own_device', invitation: secret(), expiresInMinutes: 30 })
  const deviceSecret = secret()
  const cookie = personalCookies(issuePersonalSession(store.deviceIdentity(member)))
  const input = { invitation: invitation.invitation, displayName: 'Member', deviceName: 'Another browser', deviceSecret }
  const headers = { 'origin': 'http://pod.test', cookie, 'x-sleepypod-browser-revision': 'superseded-scope' }
  const beforeDevices = store.devices(member)
  expect((await householdHttp(request('household/join', 'POST', input, undefined, headers), dependencies)).status).toBe(409)
  expect(store.devices(member)).toEqual(beforeDevices)
  expect(store.invitations(member).invitations.find(value => value.id === invitation.id)?.status).toBe('pending')
  expect(() => store.session(deviceSecret)).toThrow('unavailable')
  headers['x-sleepypod-browser-revision'] = browserScopeRevision(new Headers({ cookie })) ?? ''
  expect((await householdHttp(request('household/join', 'POST', input, undefined, headers), dependencies)).status).toBe(200)
  expect(store.session(deviceSecret).selfSleeperId).toBe(store.session(member).selfSleeperId)
})
