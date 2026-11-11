import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { HouseholdStore } from '../store'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { PersonalJournalStore } from '../personalJournal'
import { PersonalJournalApi } from '../personalJournalApi'
import { personalJournalReadResponseSchema, personalJournalWriteResponseSchema } from '../personalJournalContract'
import { personalJournalPatternsResponseSchema } from '../personalJournalPatterns'

let database: Database.Database, identities: HouseholdStore, journal: PersonalJournalStore, dependencies: HouseholdHttpDependencies
let now: number, enabled: boolean, directory: string, owner: string, member: string, legacy: string
const date = '2026-11-10', zone = 'America/Los_Angeles'
const secret = () => randomBytes(32).toString('base64url')
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
const input = () => ({ ...context(), date, expectedRevision: null, expectedTimeZone: zone,
  fields: { restfulness: 4, comfort: 'comfortable', caffeine: false, alcohol: false, exercise: false, notes: 'Private HTTP fixture.' } })
function request(path: string, method = 'GET', body?: unknown, key: string | null = owner, headers: Record<string, string> = {}) {
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
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-personal-journal-http-'))
  const filename = join(directory, 'configuration.db')
  database = migratedComfortDatabase(filename)
  vi.stubEnv('DATABASE_URL', filename)
  now = Date.parse('2026-11-11T12:00:00Z')
  enabled = true
  owner = secret()
  member = secret()
  legacy = secret()
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', legacy)
  identities = new HouseholdStore(database, () => now)
  identities.setup({ requestId: randomUUID(), displayName: 'Example owner', deviceName: 'Phone', deviceSecret: owner,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(owner, { ...context(), kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, displayName: 'Example member', deviceName: 'Tablet', deviceSecret: member })
  journal = new PersonalJournalStore(database, identities, () => zone, () => now++)
  dependencies = { store: identities, verifySoloConfiguration: () => true,
    personalJournal: new PersonalJournalApi({ identities, journal, enabled: () => enabled, now: () => now++ }) }
})
afterEach(() => {
  database.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('delivers a scoped note-free save receipt after the commit clock and reads only the authenticated journal', async () => {
  const save = await householdHttp(request('me/journal', 'POST', input()), dependencies)
  expect(save.status).toBe(200)
  const result = personalJournalWriteResponseSchema.parse(await save.json())
  expect(result.receipt?.savedAt).toBeLessThanOrEqual(result.generatedAt)
  expect(JSON.stringify(result)).not.toContain('Private HTTP fixture')
  expect(result.scope.accountId).toBe(identities.session(owner).accountId)
  const read = await householdHttp(request(`me/journal?date=${date}`), dependencies)
  const page = personalJournalReadResponseSchema.parse(await read.json())
  expect(page.entries[0].record?.fields.notes).toBe('Private HTTP fixture.')
  expect(page.interpretation).toBe('personal_self_report_not_sleep_measurement')
  expect(read.headers.get('cache-control')).toContain('no-store')
  expect(read.headers.get('vary')).toContain('X-Sleepypod-Sleeper-Id')
  const other = await householdHttp(request(`me/journal?date=${date}`, 'GET', undefined, member), dependencies)
  expect((await other.json()).entries[0].record).toBeNull()
})

it('offers receipt reconciliation without returning another account’s saved request', async () => {
  const write = input(), receipt = journal.write(owner, write)
  const result = await householdHttp(request(`me/journal/requests/${write.requestId}`), dependencies)
  expect((await result.json()).receipt).toEqual(receipt)
  const other = await householdHttp(request(`me/journal/requests/${write.requestId}`, 'GET', undefined, member), dependencies)
  expect((await other.json()).receipt).toBeNull()
})

it('reports capability withdrawal and keeps all reads and writes disabled', async () => {
  enabled = false
  const session = await householdHttp(request('household/session'), dependencies)
  expect((await session.json()).capabilities.personalJournal).toBe(false)
  for (const operation of [request(`me/journal?date=${date}`), request('me/journal', 'POST', input())])
    expect((await householdHttp(operation, dependencies)).status).toBe(409)
  expect(journal.read(owner, date).record).toBeNull()
})

it('denies installation-owner keys and invalid personal keys without falling back to a browser cookie', async () => {
  const browser = cookie(owner)
  for (const key of [legacy, secret()]) {
    const response = await householdHttp(request(`me/journal?date=${date}`, 'GET', undefined, key, { cookie: browser }), dependencies)
    expect(response.status).toBe(401)
  }
})

it('requires the pinned browser sleeper for both reads and writes', async () => {
  const browser = cookie(owner)
  for (const method of ['GET', 'POST']) {
    const path = method === 'GET' ? `me/journal?date=${date}` : 'me/journal'
    const body = method === 'GET' ? undefined : input()
    const missing = await householdHttp(request(path, method, body, null, { cookie: browser, origin: 'http://pod.test' }), dependencies)
    expect(missing.status).toBe(409)
    const wrong = await householdHttp(request(path, method, body, null, { 'cookie': browser, 'origin': 'http://pod.test',
      'x-sleepypod-sleeper-id': identities.session(member).selfSleeperId }), dependencies)
    expect(wrong.status).toBe(409)
  }
  const allowed = await householdHttp(request('me/journal', 'POST', input(), null, { 'cookie': browser, 'origin': 'http://pod.test',
    'x-sleepypod-sleeper-id': identities.session(owner).selfSleeperId }), dependencies)
  expect(allowed.status).toBe(200)
})

it.each(['revoked', 'scope', 'disabled', 'deleted', 'aborted'])('withdraws a queued private response after %s', async (change) => {
  const saved = journal.write(owner, input())
  const abort = new AbortController()
  const pending = await householdHttp(new Request(request(`me/journal?date=${date}`), { signal: abort.signal }), dependencies)
  if (change === 'revoked') database.prepare('UPDATE household_devices SET revoked_at = ?').run(now)
  if (change === 'scope') database.prepare('UPDATE household_accounts SET session_revision = session_revision + 1').run()
  if (change === 'disabled') enabled = false
  if (change === 'deleted') journal.write(owner, { ...input(), expectedRevision: saved.revision, fields: null })
  if (change === 'aborted') abort.abort()
  await expect(pending.text()).rejects.toThrow('changed before delivery')
})

it('withdraws queued notes when another browser tab changes the account', async () => {
  journal.write(owner, input())
  const browser = cookie(owner)
  const pending = await householdHttp(request(`me/journal?date=${date}`, 'GET', undefined, null, { 'cookie': browser,
    'x-sleepypod-sleeper-id': identities.session(owner).selfSleeperId }), dependencies)
  const nextSession = issuePersonalSession(identities.deviceIdentity(member))
  bindBrowserScope(request('household/session', 'POST', {}, null, { 'cookie': browser, 'origin': 'http://pod.test',
    'x-sleepypod-browser-revision': browserScopeRevision(new Headers({ cookie: browser })) ?? '' }), 'personal', nextSession)
  await expect(pending.text()).rejects.toThrow('changed before delivery')
})

it('rejects a revoked credential after a streamed save body finishes arriving', async () => {
  let bodyController!: ReadableStreamDefaultController<Uint8Array>
  const raw = new TextEncoder().encode(JSON.stringify(input()))
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    bodyController = controller
    controller.enqueue(raw.slice(0, 10))
  } })
  const upload = new Request('http://pod.test/api/v1/me/journal', { method: 'POST', headers: {
    'host': 'pod.test', 'authorization': `Bearer ${owner}`, 'content-type': 'application/json' }, body: stream,
  duplex: 'half' } as RequestInit)
  const pending = householdHttp(upload, dependencies)
  database.prepare('UPDATE household_devices SET revoked_at = ?').run(now)
  bodyController.enqueue(raw.slice(10))
  bodyController.close()
  expect((await pending).status).toBe(401)
  expect(database.prepare('SELECT COUNT(*) AS count FROM household_journal_entries').get()).toEqual({ count: 0 })
})

it('does not commit an already interrupted save or a cross-origin write', async () => {
  const abort = new AbortController()
  abort.abort()
  const interrupted = await householdHttp(new Request(request('me/journal', 'POST', input()), { signal: abort.signal }), dependencies)
  expect(interrupted.status).toBe(409)
  const crossOrigin = await householdHttp(request('me/journal', 'POST', input(), owner, { origin: 'https://outside.test' }), dependencies)
  expect(crossOrigin.status).toBe(403)
  expect(journal.read(owner, date).record).toBeNull()
})

it.each(['me/journal', 'me/journal?date=2026-11-10&date=2026-11-09', 'me/journal?date=2026-11-10&side=left',
  'me/journal?from=2026-01-01&through=2026-11-10', 'me/journal/requests/not-an-id'])('rejects invalid route selectors %s', async (path) => {
  expect((await householdHttp(request(path), dependencies)).status).toBe(400)
})

it('rejects query parameters on writes and unknown fields without retaining content', async () => {
  expect((await householdHttp(request('me/journal?side=left', 'POST', input()), dependencies)).status).toBe(400)
  expect((await householdHttp(request('me/journal', 'POST', { ...input(), accountId: identities.session(member).accountId }), dependencies)).status).toBe(400)
  expect(journal.read(owner, date).record).toBeNull()
})

it('returns a generic unavailable response for corrupt saved content without echoing it', async () => {
  journal.write(owner, input())
  database.prepare('UPDATE household_journal_entries SET fields = ?').run('private-corruption-marker')
  const result = await householdHttp(request(`me/journal?date=${date}`), dependencies)
  expect(result.status).toBe(503)
  expect(await result.text()).not.toContain('private-corruption-marker')
})

it('serves note-free patterns from only the authenticated person, without counting a partner’s journal', async () => {
  journal.write(owner, input())
  journal.write(member, { ...input(), fields: { ...input().fields, notes: 'private-member-marker', comfort: 'warm' } })
  const path = `me/journal/patterns?from=${date}&through=${date}`
  const session = await householdHttp(request('household/session'), dependencies)
  expect((await session.json()).capabilities.personalJournalPatterns).toBe(true)
  for (const key of [owner, member]) {
    const result = await householdHttp(request(path, 'GET', undefined, key), dependencies)
    expect(result.status).toBe(200)
    expect(result.headers.get('cache-control')).toContain('no-store')
    const patterns = personalJournalPatternsResponseSchema.parse(await result.json())
    expect(patterns.scope.accountId).toBe(identities.session(key).accountId)
    expect(patterns.cohorts[0].dates).toBe(1)
    expect(patterns.cohorts[0].comparisons.every(item => item.warmRateDifferencePoints === null && item.excludedCount === 1)).toBe(true)
    expect(JSON.stringify(patterns)).not.toMatch(/Private HTTP fixture|private-member-marker/)
  }
  expect((await householdHttp(request(path, 'GET', undefined, legacy), dependencies)).status).toBe(401)
  expect((await householdHttp(request(path, 'POST', input()), dependencies)).status).not.toBe(200)
  enabled = false
  expect((await householdHttp(request(path), dependencies)).status).toBe(409)
})

it.each(['revoked', 'scope', 'disabled', 'deleted', 'aborted'])('withdraws queued personal comparisons after %s', async (change) => {
  const saved = journal.write(owner, input()), abort = new AbortController()
  const pending = await householdHttp(new Request(request(`me/journal/patterns?from=${date}&through=${date}`), { signal: abort.signal }), dependencies)
  if (change === 'revoked') database.prepare('UPDATE household_devices SET revoked_at = ?').run(now)
  if (change === 'scope') database.prepare('UPDATE household_accounts SET session_revision = session_revision + 1').run()
  if (change === 'disabled') enabled = false
  if (change === 'deleted') journal.write(owner, { ...input(), expectedRevision: saved.revision, fields: null })
  if (change === 'aborted') abort.abort()
  await expect(pending.text()).rejects.toThrow('changed before delivery')
})

it.each(['me/journal/patterns', 'me/journal/patterns?date=2026-11-10',
  'me/journal/patterns?from=2026-01-01&through=2026-11-10',
  'me/journal/patterns?from=2026-11-01&through=2026-11-10&accountId=another'])('rejects unsupported comparison selectors %s', async (path) => {
  expect((await householdHttp(request(path), dependencies)).status).toBe(400)
})
