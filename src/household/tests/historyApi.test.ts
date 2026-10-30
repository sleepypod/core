import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { personalRuntimeFixture } from './runtimeFixture'
import { PersonHistoryStore } from '../personHistory'
import { PersonalHistoryApi } from '../historyApi'
import { householdHttp } from '../http'
import { personalHistoryDetailSchema, personalHistoryPageSchema } from '../historyApiContract'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { bindBrowserScope } from '@/src/auth/browserScope'

const hour = 3600_000
let fixture: ReturnType<typeof personalRuntimeFixture>, history: PersonHistoryStore, api: PersonalHistoryApi
let startedAt: number, datasetId: string, enabled: boolean
let directory: string
const query = () => new URLSearchParams({ startsAt: String(startedAt), endsAt: String(startedAt + 10 * 24 * hour), kind: 'presence', limit: '1' })
const request = (path = `me/sleep?${query()}`, key: string | null = fixture.ownerKey, headers: Record<string, string> = {}, signal?: AbortSignal) => new Request(`http://pod.test/api/v1/${path}`, {
  headers: { host: 'pod.test', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers }, signal,
})
const serve = (incoming = request()) => householdHttp(incoming, { store: fixture.identities, personalHistory: api, verifySoloConfiguration: () => true })
function personalCookies(value: string) {
  const cookie = bindBrowserScope(request('household/session'), 'personal', value).split(';')[0]
  return `${PERSONAL_COOKIE}=${value}; ${cookie}`
}
function admit(side: 'left' | 'right', at: number, sourceRecordKey = randomUUID()) {
  return history.admitObservation({ householdId: fixture.owner.householdId, datasetId, sourceRecordKey,
    recordedSide: side, startsAt: at, endsAt: at + 8 * hour,
    payload: { kind: 'presence', reportedPresenceSeconds: 7 * 3600, exits: 2, interpretation: 'bed_presence_not_sleep' } })
}
function requireId(value: ReturnType<typeof admit>) {
  if (!value.personRecordId) throw new Error('Fixture record was not admitted')
  return value.personRecordId
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'personal-history-http-'))
  const databasePath = join(directory, 'configuration.db')
  vi.stubEnv('DATABASE_URL', databasePath)
  fixture = personalRuntimeFixture(databasePath)
  startedAt = fixture.clock.now
  fixture.clock.now += 10 * 24 * hour
  datasetId = randomUUID()
  enabled = true
  history = new PersonHistoryStore(fixture.database, fixture.identities, () => fixture.clock.now)
  api = new PersonalHistoryApi({ identities: fixture.identities, history, enabled: () => enabled, now: () => fixture.clock.now })
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', randomBytes(32).toString('base64url'))
})
afterEach(() => {
  fixture.database.close()
  rmSync(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
function epoch() {
  return history.appendReviewedEpoch({ householdId: fixture.owner.householdId, datasetId, startsAt: startedAt, endsAt: null,
    expectedAttributionRevision: 1, mode: 'assigned', basis: 'verified_arrangement', reviewedBy: fixture.owner.accountId,
    reviewReceiptId: randomUUID(), assignments: [{ sleeperId: fixture.owner.selfSleeperId, recordedSide: 'right' },
      { sleeperId: fixture.member.selfSleeperId, recordedSide: 'left' }] })
}

describe('personal history HTTP', () => {
  it('returns an explicit empty attributed history without claiming old zone data or sleep duration', async () => {
    const response = await serve()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(personalHistoryPageSchema.parse(await response.json())).toMatchObject({ version: 1,
      scope: { sleeperId: fixture.owner.selfSleeperId, accountId: fixture.owner.accountId },
      source: 'pod', interpretation: 'recordings_not_confirmed_sleep', records: [], nextCursor: null })
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(fixture.observe).not.toHaveBeenCalled()
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_attribution_epochs').get()).toEqual({ count: 0 })
  })

  it('advertises only the enabled read capability; Health and assignment activation stay unavailable', async () => {
    expect(await (await serve(request('household/session'))).json()).toMatchObject({ capabilities: { personalHistory: true, healthImport: false, activateArrangement: false } })
    enabled = false
    expect(await (await serve(request('household/session'))).json()).toMatchObject({ capabilities: { personalHistory: false } })
    expect((await serve()).status).toBe(409)
  })

  it('resolves both list and details from the credential, including for the household administrator', async () => {
    epoch()
    const ownerId = requireId(admit('right', startedAt + hour))
    const memberId = requireId(admit('left', startedAt + hour))
    for (const [key, ownId, otherId, sleeperId] of [[fixture.ownerKey, ownerId, memberId, fixture.owner.selfSleeperId], [fixture.memberKey, memberId, ownerId, fixture.member.selfSleeperId]]) {
      const page = personalHistoryPageSchema.parse(await (await serve(request(undefined, key))).json())
      expect(page.records.map(record => record.id)).toEqual([ownId])
      expect(page.scope.sleeperId).toBe(sleeperId)
      const detail = personalHistoryDetailSchema.parse(await (await serve(request(`me/sleep/${ownId}`, key))).json())
      expect(detail.record.id).toBe(ownId)
      const forbidden = await serve(request(`me/sleep/${otherId}`, key))
      const missing = await serve(request(`me/sleep/${randomUUID()}`, key))
      expect(forbidden.status).toBe(404)
      expect(await forbidden.json()).toEqual(await missing.json())
    }
  })

  it('includes complete recordings crossing the requested boundary, without silently dropping overnight time', async () => {
    epoch()
    const recordId = requireId(admit('right', startedAt + hour))
    const range = new URLSearchParams({ startsAt: String(startedAt + 2 * hour), endsAt: String(startedAt + 3 * hour), kind: 'presence' })
    const page = personalHistoryPageSchema.parse(await (await serve(request(`me/sleep?${range}`))).json())
    expect(page.intervalSelection).toBe('overlap_full_records')
    expect(page.records[0]).toMatchObject({ id: recordId, startsAt: startedAt + hour, endsAt: startedAt + 9 * hour })
    expect(page.records[0].payload).toMatchObject({ reportedPresenceSeconds: 7 * 3600 })
    range.set('startsAt', String(startedAt + 9 * hour))
    range.set('endsAt', String(startedAt + 10 * hour))
    expect((await (await serve(request(`me/sleep?${range}`))).json()).records).toEqual([])
  })

  it('uses signed snapshot pagination and rejects another person, changed query or revision', async () => {
    epoch()
    const firstId = requireId(admit('right', startedAt + hour))
    const secondId = requireId(admit('right', startedAt + 24 * hour))
    const first = await (await serve()).json()
    expect(first.records[0].id).toBe(secondId)
    const next = query()
    next.set('cursor', first.nextCursor)
    admit('right', startedAt + 48 * hour)
    expect((await (await serve(request(`me/sleep?${next}`))).json()).records[0].id).toBe(firstId)
    expect((await serve(request(`me/sleep?${next}`, fixture.memberKey))).status).toBe(409)
    next.set('limit', '2')
    expect((await serve(request(`me/sleep?${next}`))).status).toBe(409)
  })

  it('keeps vital and movement measurements distinct from presence and Apple Watch metrics', async () => {
    epoch()
    for (const payload of [
      { kind: 'vitals', heartRateBpm: 61, breathingRatePerMinute: null, hrvMs: 28, hrvMetric: 'window_ibi_variability_v1' },
      { kind: 'movement', total: 42, interpretation: 'movement_not_sleep_stage' },
    ]) {
      history.admitObservation({ householdId: fixture.owner.householdId, datasetId, sourceRecordKey: randomUUID(), recordedSide: 'right',
        startsAt: startedAt + hour, endsAt: startedAt + hour + 60_000, payload })
      const range = query()
      range.set('kind', payload.kind)
      const page = personalHistoryPageSchema.parse(await (await serve(request(`me/sleep?${range}`))).json())
      expect(page.records[0].payload).toEqual(payload)
      expect(page.source).toBe('pod')
      expect((await (await serve(request(`me/sleep?${range}`, fixture.memberKey))).json()).records).toEqual([])
    }
  })

  it.each(['side=left', 'sleeperId=someone', 'limit=2&limit=3', 'startsAt=1', 'limit=1e2', 'limit=-1', 'limit=101', 'cursor='])('rejects malformed or foreign query selectors: %s', async (extra) => {
    const response = await serve(request(`me/sleep?${query()}&${extra}`))
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain(extra)
  })

  it('rejects nonpersonal keys, unpinned cookie reads, cross-origin requests and write attempts', async () => {
    for (const key of [process.env.SLEEPYPOD_AUTH_TOKEN, randomBytes(32).toString('base64url'), null])
      expect((await serve(request(undefined, key))).status).toBe(401)
    const cookie = personalCookies(issuePersonalSession(fixture.identities.deviceIdentity(fixture.ownerKey)))
    expect((await serve(request(undefined, null, { cookie }))).status).toBe(409)
    expect((await serve(request(undefined, null, { cookie, 'x-sleepypod-sleeper-id': fixture.member.selfSleeperId }))).status).toBe(409)
    expect((await serve(request(undefined, null, { cookie, 'x-sleepypod-sleeper-id': fixture.owner.selfSleeperId }))).status).toBe(200)
    expect((await serve(request(undefined, fixture.ownerKey, { origin: 'https://elsewhere.test' }))).status).toBe(403)
    expect((await serve(new Request(request(), { method: 'POST', headers: { 'authorization': `Bearer ${fixture.ownerKey}`, 'content-type': 'application/json' }, body: '{}' }))).status).toBe(404)
    expect((await serve(request(`me/sleep/${randomUUID()}?side=left`))).status).toBe(400)
  })

  it.each(['device', 'account', 'assignment', 'epoch', 'record', 'disabled', 'abort'] as const)('withholds selected bytes when %s changes before response delivery', async (change) => {
    const savedEpoch = epoch()
    const recordId = requireId(admit('right', startedAt + hour))
    const abort = new AbortController()
    const response = await serve(request(`me/sleep/${recordId}`, fixture.ownerKey, {}, abort.signal))
    expect(response.status).toBe(200)
    if (change === 'device') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, fixture.identities.deviceIdentity(fixture.ownerKey))
    if (change === 'account') fixture.database.prepare('UPDATE household_accounts SET state = \'revoked\' WHERE id = ?').run(fixture.owner.accountId)
    if (change === 'assignment') fixture.database.prepare('UPDATE households SET assignment_revision = assignment_revision + 1').run()
    if (change === 'epoch') fixture.database.prepare('UPDATE household_attribution_epochs SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, savedEpoch.epochId)
    if (change === 'record') fixture.database.prepare('UPDATE household_person_records SET invalidated_at = ? WHERE id = ?').run(fixture.clock.now, recordId)
    if (change === 'disabled') enabled = false
    if (change === 'abort') abort.abort()
    await expect(response.text()).rejects.toThrow('before delivery')
  })

  it.each(['{private-corruption', '{"kind":"presence","reportedPresenceSeconds":999999,"exits":0,"interpretation":"bed_presence_not_sleep"}'])('rejects corrupt persisted payloads without echoing database values', async (payload) => {
    epoch()
    const recordId = requireId(admit('right', startedAt + hour))
    fixture.database.prepare('UPDATE household_person_records SET payload = ? WHERE id = ?').run(payload, recordId)
    const response = await serve()
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('private-corruption')
  })
})
