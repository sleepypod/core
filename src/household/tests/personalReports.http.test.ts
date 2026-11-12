import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { MorningReportStore } from '@/src/reports/store'
import { reportFixture, reportNow } from '@/src/reports/tests/fixture'
import { HouseholdStore } from '../store'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { PersonalReportsApi } from '../personalReportsApi'

let database: Database.Database, identities: HouseholdStore, dependencies: HouseholdHttpDependencies
let directory: string, owner: string, member: string, legacy: string
const secret = () => randomBytes(32).toString('base64url')
function request(suffix = '', method = 'GET', body?: unknown, key: string | null = owner, headers: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/me/reports${suffix}`, { method, headers: { host: 'pod.test',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
const serve = (input: Request) => householdHttp(input, dependencies)
function cookie(key: string) {
  const session = issuePersonalSession(identities.deviceIdentity(key))
  const binding = bindBrowserScope(request(), 'personal', session).split(';')[0]
  return `${PERSONAL_COOKIE}=${session}; ${binding}`
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-reports-http-'))
  const filename = join(directory, 'configuration.db')
  database = migratedComfortDatabase(filename)
  vi.stubEnv('DATABASE_URL', filename)
  owner = secret()
  member = secret()
  legacy = secret()
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', legacy)
  identities = new HouseholdStore(database, () => reportNow)
  identities.setup({ requestId: randomUUID(), displayName: 'Fixture owner', deviceName: 'Phone', deviceSecret: owner,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(owner, { requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1,
    kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, displayName: 'Fixture partner', deviceName: 'Tablet', deviceSecret: member })
  dependencies = { store: identities, verifySoloConfiguration: () => true,
    personalReports: new PersonalReportsApi(identities, new MorningReportStore(database, () => reportNow), () => reportNow) }
})
afterEach(() => {
  database.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('binds reports to the authenticated person and keeps another sleeper’s records private', async () => {
  const input = reportFixture()
  const saved = await serve(request(`/${input.report.id}`, 'PUT', { expectedRevision: null, document: input }))
  expect(saved.status).toBe(200)
  const result = await saved.json()
  expect(result.scope.accountId).toBe(identities.session(owner).accountId)
  expect(result.report).toEqual(input.report)
  expect((await serve(request())).headers.get('cache-control')).toContain('no-store')
  expect((await (await serve(request('', 'GET', undefined, member))).json()).reports).toEqual([])
  expect((await serve(request(`/${input.report.id}`, 'GET', undefined, member))).status).toBe(404)
  const removed = await serve(request(`/${input.report.id}`, 'DELETE', { expectedRevision: result.receipt.revision }))
  expect((await removed.json()).report).toBeNull()
  expect((await serve(request(`/${input.report.id}`, 'PUT', { expectedRevision: null, document: input }))).status).toBe(409)
})

it('denies legacy and invalid keys even when an authorized browser cookie is present', async () => {
  const browser = cookie(owner)
  for (const key of [legacy, secret()])
    expect((await serve(request('', 'GET', undefined, key, { cookie: browser }))).status).toBe(401)
})

it('pins browser reads, saves and deletions to the displayed sleeper', async () => {
  const browser = cookie(owner), input = reportFixture(), ownerSleeper = identities.session(owner).selfSleeperId
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const body = method === 'GET' ? undefined : { expectedRevision: null, ...(method === 'PUT' ? { document: input } : {}) }
    for (const sleeper of ['', identities.session(member).selfSleeperId]) {
      const response = await serve(request(`/${input.report.id}`, method, body, null, {
        'cookie': browser, 'origin': 'http://pod.test', 'x-sleepypod-sleeper-id': sleeper,
      }))
      expect(response.status).toBe(409)
    }
  }
  const allowed = await serve(request(`/${input.report.id}`, 'PUT', { expectedRevision: null, document: input }, null,
    { 'cookie': browser, 'origin': 'http://pod.test', 'x-sleepypod-sleeper-id': ownerSleeper }))
  expect(allowed.status).toBe(200)
})

it.each(['revoked', 'membership', 'revision', 'aborted'])('withdraws private reports after %s changes', async (kind) => {
  const input = reportFixture(), abort = new AbortController()
  await (await serve(request(`/${input.report.id}`, 'PUT', { expectedRevision: null, document: input }))).text()
  const pending = await serve(new Request(request(`/${input.report.id}`), { signal: abort.signal }))
  if (kind === 'revoked') database.exec(`UPDATE household_devices SET revoked_at = ${reportNow}`)
  if (kind === 'membership') database.exec('UPDATE household_accounts SET state = \'removed\'')
  if (kind === 'revision') database.exec('UPDATE household_accounts SET session_revision = session_revision + 1')
  if (kind === 'aborted') abort.abort()
  await expect(pending.text()).rejects.toThrow('changed before delivery')
})

it('withdraws an old tab’s response after a browser account switch', async () => {
  const browser = cookie(owner)
  const pending = await serve(request('', 'GET', undefined, null, { 'cookie': browser,
    'x-sleepypod-sleeper-id': identities.session(owner).selfSleeperId }))
  bindBrowserScope(request('', 'PUT', {}, null, { 'cookie': browser, 'origin': 'http://pod.test',
    'x-sleepypod-browser-revision': browserScopeRevision(new Headers({ cookie: browser })) ?? '' }),
  'personal', issuePersonalSession(identities.deviceIdentity(member)))
  await expect(pending.text()).rejects.toThrow('changed before delivery')
})

it('rechecks credentials after a streamed upload and never commits a revoked person’s document', async () => {
  const input = reportFixture(), bytes = new TextEncoder().encode(JSON.stringify({ expectedRevision: null, document: input }))
  let uploadController!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    uploadController = controller
    controller.enqueue(bytes.slice(0, 10))
  } })
  const pending = serve(new Request(`http://pod.test/api/v1/me/reports/${input.report.id}`, { method: 'PUT', headers: {
    'host': 'pod.test', 'authorization': `Bearer ${owner}`, 'content-type': 'application/json' }, body: stream, duplex: 'half',
  } as RequestInit))
  database.exec(`UPDATE household_devices SET revoked_at = ${reportNow}`)
  uploadController.enqueue(bytes.slice(10))
  uploadController.close()
  expect((await pending).status).toBe(401)
  expect(database.prepare('SELECT COUNT(*) AS count FROM morning_reports').get()).toEqual({ count: 0 })
})

it('rejects foreign origins, account selectors and unknown body fields without retaining content', async () => {
  const input = reportFixture(), body = { expectedRevision: null, document: input }
  expect((await serve(request(`/${input.report.id}`, 'PUT', body, owner, { origin: 'https://outside.test' }))).status).toBe(403)
  expect((await serve(request(`/${input.report.id}?accountId=${identities.session(member).accountId}`, 'PUT', body))).status).toBe(400)
  expect((await serve(request(`/${input.report.id}`, 'PUT', { ...body, accountId: identities.session(member).accountId }))).status).toBe(400)
  expect(database.prepare('SELECT COUNT(*) AS count FROM morning_reports').get()).toEqual({ count: 0 })
})

it('accepts bounded reports larger than the routine limit, while leaving the routine limit unchanged', async () => {
  const input = reportFixture()
  input.report.text = 'r'.repeat(60000)
  input.report.facts = Array.from({ length: 12 }, (_, index) => ({ id: `health.example${index}`, text: 'e'.repeat(8000) }))
  expect((await serve(request(`/${input.report.id}`, 'PUT', { expectedRevision: null, document: input }))).status).toBe(200)
  const routine = new Request('http://pod.test/api/v1/me/routines', { method: 'PUT', headers: {
    'host': 'pod.test', 'authorization': `Bearer ${owner}`, 'content-type': 'application/json' }, body: JSON.stringify(input) })
  expect((await householdHttp(routine, dependencies)).status).toBe(413)
})
