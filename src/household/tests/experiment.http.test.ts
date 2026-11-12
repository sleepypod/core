import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { createComfortLimitStore } from '@/src/temperature/limitStore'
import { ComfortExperimentService } from '@/src/comfort/experiments/service'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { PersonalExperimentApi } from '../experimentApi'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { personalRuntimeFixture } from './runtimeFixture'

let fixture: ReturnType<typeof personalRuntimeFixture>, dependencies: HouseholdHttpDependencies, directory: string
const proposal = { firstNightDate: '2026-11-13', variantF: 71 }
function request(path = '', method = 'GET', body?: unknown, key: string | null = fixture.ownerKey, extra: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/me/comfort-experiments${path}`, { method, headers: {
    host: 'pod.test', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...extra,
  }, ...(body ? { body: JSON.stringify(body) } : {}) })
}
async function call(path = '', method = 'GET', body?: unknown, key = fixture.ownerKey) {
  return householdHttp(request(path, method, body, key), dependencies)
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-experiment-http-'))
  const filename = join(directory, 'config.db')
  fixture = personalRuntimeFixture(filename)
  fixture.clock.now = Date.parse('2026-11-12T12:00:00Z')
  vi.stubEnv('DATABASE_URL', filename)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', 'fixture-owner-signing-key-not-a-real-credential')
  fixture.database.exec(`INSERT INTO power_schedules (side, day_of_week, on_time, off_time, off_day_offset, on_temperature)
    VALUES ('left', 'monday', '22:00', '07:15', 1, 70), ('right', 'monday', '22:00', '07:15', 1, 72),
      ('left', 'tuesday', '22:00', '07:15', 1, 70), ('right', 'tuesday', '22:00', '07:15', 1, 72);`)
  createComfortLimitStore(fixture.database).save('left', 0, { enabled: true, minF: 70, maxF: 72 })
  createComfortLimitStore(fixture.database).save('right', 0, { enabled: true, minF: 71, maxF: 74 })
  const service = new ComfortExperimentService(fixture.database, () => fixture.clock.now)
  dependencies = { store: fixture.identities, verifySoloConfiguration: () => true, personalRuntime: fixture.runtime,
    personalExperiments: new PersonalExperimentApi(fixture.identities, fixture.runtime.authority, service, () => fixture.clock.now) }
})
afterEach(() => {
  fixture.database.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('authenticates the actual endpoint, prepares against the owner’s solo routine and never queries or controls hardware', async () => {
  expect((await householdHttp(request('', 'GET', undefined, null), dependencies)).status).toBe(401)
  const prepared = await call('/preview', 'POST', proposal)
  expect(prepared.status).toBe(200)
  const review = await prepared.json()
  expect(review.plan.context).toMatchObject({ baselineF: 70, minimumF: 70, maximumF: 72 })
  const saved = await call('/confirm', 'POST', { reviewId: review.reviewId, planHash: review.planHash })
  expect((await saved.json()).record.status).toBe('planned')
  expect(fixture.execute).not.toHaveBeenCalled()
  expect(fixture.observe).not.toHaveBeenCalled()
})

it('isolates partners and derives each assigned side instead of accepting a client side', async () => {
  expect((await call('/preview', 'POST', proposal, fixture.memberKey)).status).toBe(409)
  fixture.assignedFixture()
  const owner = await (await call('/preview', 'POST', { ...proposal, variantF: 73 })).json()
  const member = await (await call('/preview', 'POST', proposal, fixture.memberKey)).json()
  expect(owner.plan.context.baselineF).toBe(72)
  expect(member.plan.context.baselineF).toBe(70)
  const saved = await (await call('/confirm', 'POST', { reviewId: owner.reviewId, planHash: owner.planHash })).json()
  expect((await call(`/${saved.record.plan.id}`, 'GET', undefined, fixture.memberKey)).status).toBe(404)
  expect((await call('/preview', 'POST', { ...proposal, side: 'right' }, fixture.memberKey)).status).toBe(400)
  expect((await (await call('', 'GET', undefined, fixture.memberKey)).json()).experiments).toEqual([])
})

it('invalidates reviews on reassignment and withholds a delayed response after revocation', async () => {
  const review = await (await call('/preview', 'POST', proposal)).json()
  fixture.assignedFixture()
  expect((await call('/confirm', 'POST', { reviewId: review.reviewId, planHash: review.planHash })).status).toBe(409)
  const pending = await call()
  fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(fixture.clock.now, fixture.owner.accountId)
  await expect(pending.text()).rejects.toThrow('changed')
})

it('requires the selected sleeper and same origin for browser use, then withdraws content after sign-out', async () => {
  const session = issuePersonalSession(fixture.identities.deviceIdentity(fixture.ownerKey))
  const binding = bindBrowserScope(request(), 'personal', session).split(';')[0]
  const cookie = `${PERSONAL_COOKIE}=${session}; ${binding}`
  expect((await householdHttp(request('', 'GET', undefined, null, { cookie }), dependencies)).status).toBe(409)
  const headers = { cookie, 'origin': 'http://pod.test', 'x-sleepypod-sleeper-id': fixture.owner.selfSleeperId }
  expect((await householdHttp(request('/preview', 'POST', proposal, null, { ...headers, origin: 'https://outside.test' }), dependencies)).status).toBe(403)
  const incoming = request('', 'GET', undefined, null, headers), pending = await householdHttp(incoming, dependencies)
  incoming.headers.set('x-sleepypod-browser-revision', browserScopeRevision(incoming.headers) ?? '')
  bindBrowserScope(incoming, 'signed_out', '')
  await expect(pending.text()).rejects.toThrow('changed')
})

it('reads all input before authorizing a write and rejects a device revoked during upload', async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    writer = controller
  } })
  const incoming = new Request('http://pod.test/api/v1/me/comfort-experiments/preview', { method: 'POST', body, duplex: 'half',
    headers: { 'authorization': `Bearer ${fixture.ownerKey}`, 'content-type': 'application/json' } } as RequestInit)
  const pending = householdHttp(incoming, dependencies)
  fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?').run(fixture.clock.now, fixture.owner.accountId)
  writer.enqueue(new TextEncoder().encode(JSON.stringify(proposal)))
  writer.close()
  expect((await pending).status).toBe(401)
  expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM comfort_experiments').get()).toEqual({ count: 0 })
})
