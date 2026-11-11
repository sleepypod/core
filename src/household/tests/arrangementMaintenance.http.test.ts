import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bindBrowserScope, browserScopeRevision } from '@/src/auth/browserScope'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { issuePersonalSession, PERSONAL_COOKIE } from '../browserSession'
import { arrangementMaintenanceStatusSchema } from '../arrangementMaintenanceContract'
import { arrangementCoordinatorFixture } from './arrangementCoordinatorFixture'

let fixture: ReturnType<typeof arrangementCoordinatorFixture>, dependencies: HouseholdHttpDependencies, directory: string, legacyKey: string
function request(suffix = '', method = 'GET', body?: unknown, key?: string, headers: Record<string, string> = {}) {
  return new Request(`http://pod.test/api/v1/household/transition${suffix}`, { method,
    headers: { host: 'pod.test', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
function browserHeaders() {
  const token = issuePersonalSession(fixture.identities.deviceIdentity(fixture.ownerKey))
  const scope = bindBrowserScope(request(), 'personal', token).split(';')[0]
  const cookie = `${PERSONAL_COOKIE}=${token}; ${scope}`
  return { cookie, 'origin': 'http://pod.test', 'x-sleepypod-sleeper-id': fixture.owner.selfSleeperId,
    'x-sleepypod-browser-revision': browserScopeRevision(new Headers({ cookie })) ?? '' }
}
function coordinator() {
  if (!dependencies.arrangementCoordinator) throw new Error('Missing fixture coordinator')
  return dependencies.arrangementCoordinator
}
async function status(key = fixture.ownerKey, suffix = '') {
  const response = await householdHttp(request(suffix, 'GET', undefined, key), dependencies)
  expect(response.status).toBe(200)
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('vary')).toBe('Authorization, Cookie')
  return arrangementMaintenanceStatusSchema.parse(await response.json())
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleepypod-arrangement-http-'))
  const databasePath = join(directory, 'configuration.db')
  fixture = arrangementCoordinatorFixture(databasePath)
  legacyKey = randomBytes(32).toString('base64url')
  vi.stubEnv('DATABASE_URL', databasePath)
  vi.stubEnv('SLEEPYPOD_AUTH_TOKEN', legacyKey)
  dependencies = { store: fixture.identities, arrangementCoordinator: fixture.makeCoordinator(), verifySoloConfiguration: () => true }
})
afterEach(() => {
  fixture.close()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

describe('household maintenance HTTP lifecycle', () => {
  it('rejects legacy, missing and partner credentials before reading or suspending hardware', async () => {
    for (const [key, expected] of [[undefined, 401], [legacyKey, 401], [fixture.memberKey, 403]] as const) {
      expect((await householdHttp(request('', 'POST', fixture.request, key), dependencies)).status).toBe(expected)
      expect((await householdHttp(request('', 'GET', undefined, key), dependencies)).status).toBe(expected)
    }
    expect(fixture.readEvidence).not.toHaveBeenCalled()
    expect(fixture.readGeneration).not.toHaveBeenCalled()
    expect(fixture.suspend).not.toHaveBeenCalled()
  })

  it('reads no operation, then the durable committed transition after a lost response', async () => {
    expect((await status()).operation).toBeNull()
    const saved = await householdHttp(request('', 'POST', fixture.request, fixture.ownerKey), dependencies)
    expect(saved.status).toBe(200)
    const events = [...fixture.events]
    const current = await status()
    expect(current).toMatchObject({ expectedAssignmentRevision: 2, operation: {
      operationId: fixture.request.requestId, state: 'committed', admission: 'held_for_this_transition', controllerRestarted: false,
      recovery: null, cancellation: null } })
    const explicit = await status(fixture.ownerKey, `?operationId=${fixture.request.requestId}`)
    expect(explicit).toEqual(current)
    expect(fixture.events).toEqual(events)
    expect(JSON.stringify(current)).not.toMatch(/archive|request_hash|invocationId|profiles|device_id|processing|preferences/)
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('keeps interrupted activation visible without retrying it from a read', async () => {
    fixture.drainBase.mockRejectedValueOnce(new Error('fixture drain error'))
    const response = await householdHttp(request('', 'POST', fixture.request, fixture.ownerKey), dependencies)
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('fixture drain error')
    expect((await status()).operation).toMatchObject({ state: 'held', admission: 'held_for_this_transition' })
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.suspend).toHaveBeenCalledTimes(1)
  })

  it('reports unknown generation and unavailable admission rather than a successful restart', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    fixture.readGeneration.mockRejectedValueOnce(new Error('service not readable'))
    fixture.database.prepare('DELETE FROM hardware_admission').run()
    expect((await status()).operation).toMatchObject({ state: 'committed', admission: 'unavailable', controllerRestarted: null })
  })

  it.each([-5001, 1])('withholds a service observation offset by %i milliseconds', async (offset) => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    const generation = await fixture.readGeneration()
    fixture.readGeneration.mockResolvedValueOnce({ ...generation, observedAt: fixture.clock.now + offset })
    expect((await status()).operation?.controllerRestarted).toBeNull()
    expect(fixture.restartService).not.toHaveBeenCalled()
  })

  it('submits an attended browser restart once and reads its result without releasing the hold', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    const input = fixture.restartRequest()
    const headers = browserHeaders()
    const response = await householdHttp(request('/restart', 'POST', input, undefined, headers), dependencies)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(await response.json()).toMatchObject({ replayed: false, receipt: { state: 'submitted', replayAllowed: false } })
    const replay = await householdHttp(request('/restart', 'POST', input, undefined, headers), dependencies)
    expect(await replay.json()).toMatchObject({ replayed: true, receipt: { state: 'submitted' } })
    expect((await status()).operation).toMatchObject({ state: 'committed', admission: 'held_for_this_transition',
      controllerRestarted: false, restart: { requestId: input.requestId } })
    expect(fixture.restartService).toHaveBeenCalledTimes(1)
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it.each(['browser logout', 'device revoked'] as const)('does not restart after %s during draining', async (change) => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    const deviceId = fixture.identities.deviceIdentity(fixture.ownerKey)
    const incoming = request('/restart', 'POST', fixture.restartRequest(),
      change === 'device revoked' ? fixture.ownerKey : undefined, change === 'browser logout' ? browserHeaders() : {})
    fixture.drainBase.mockImplementationOnce(async () => {
      if (change === 'browser logout') bindBrowserScope(incoming, 'signed_out', '')
      else fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(fixture.clock.now, deviceId)
    })
    const response = await householdHttp(incoming, dependencies)
    expect([401, 403]).toContain(response.status)
    expect(fixture.restartService).not.toHaveBeenCalled()
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_arrangement_restarts').get()).toEqual({ count: 0 })
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
  })

  it('retains a submitted restart but withholds its response after browser logout', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    const incoming = request('/restart', 'POST', fixture.restartRequest(), undefined, browserHeaders())
    fixture.restartService.mockImplementationOnce(async () => {
      bindBrowserScope(incoming, 'signed_out', '')
    })
    const response = await householdHttp(incoming, dependencies)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('requestedAt')
    expect((await status()).operation?.restart?.state).toBe('submitted')
    expect(fixture.restartService).toHaveBeenCalledTimes(1)
  })

  it('recovers after a verified restart and reads an expired completion without replaying services', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    dependencies.arrangementCoordinator = fixture.restart()
    expect((await status()).operation).toMatchObject({ state: 'committed', controllerRestarted: true })
    const input = fixture.recoveryRequest()
    const recovered = await householdHttp(request('/recover', 'POST', input, fixture.ownerKey), dependencies)
    expect(recovered.status).toBe(200)
    fixture.clock.now += 90000
    fixture.clock.enabled = false
    const events = [...fixture.events]
    expect((await status()).operation).toMatchObject({ state: 'completed', admission: 'open', recovery: { requestId: input.requestId } })
    expect(fixture.events).toEqual(events)
    expect(fixture.resume).toHaveBeenCalledTimes(1)
  })

  it('cancels a held transition through a fresh preview and preserves solo assignment', async () => {
    fixture.drainBase.mockRejectedValueOnce(new Error('interrupted'))
    await householdHttp(request('', 'POST', fixture.request, fixture.ownerKey), dependencies)
    dependencies.arrangementCoordinator = fixture.restart(false)
    const preview = await householdHttp(request(`/cancellation-preview?operationId=${fixture.request.requestId}`, 'GET', undefined, fixture.ownerKey), dependencies)
    expect(preview.status).toBe(200)
    const input = { ...fixture.context(), version: 1, operationId: fixture.request.requestId,
      issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000, expectedControlDigest: (await preview.json()).controlDigest,
      confirmEmptyAndAttended: true, confirmKeepSoloArrangement: true, acknowledgeSavedRoutinesMayResume: true }
    expect((await householdHttp(request('/cancel', 'POST', input, fixture.ownerKey), dependencies)).status).toBe(200)
    expect((await status()).operation).toMatchObject({ state: 'cancelled', admission: 'open', cancellation: { requestId: input.requestId } })
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.resume).toHaveBeenCalledTimes(1)
  })

  it('withholds an invalid saved completion instead of declaring success', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    dependencies.arrangementCoordinator = fixture.restart()
    await dependencies.arrangementCoordinator.recover(fixture.ownerKey, fixture.recoveryRequest())
    const row = fixture.database.prepare('SELECT recovery FROM household_arrangement_transitions').get() as { recovery: string }
    const saved = JSON.parse(row.recovery)
    saved.receipt.admissionRevision++
    fixture.database.prepare('UPDATE household_arrangement_transitions SET recovery = ?').run(JSON.stringify(saved))
    const response = await householdHttp(request('', 'GET', undefined, fixture.ownerKey), dependencies)
    expect(response.status).toBe(409)
    expect(await response.text()).not.toContain('completedAt')
  })

  it('returns the same absent result for another owner device, an unknown ID and its corrupt private row', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    const invitation = fixture.identities.createInvitation(fixture.ownerKey, { ...fixture.context(), kind: 'own_device',
      invitation: randomBytes(32).toString('base64url'), expiresInMinutes: 30 })
    const key = randomBytes(32).toString('base64url')
    fixture.identities.join({ invitation: invitation.invitation, displayName: 'Owner', deviceName: 'Another device', deviceSecret: key })
    expect((await status(key)).operation).toBeNull()
    expect((await status(key, `?operationId=${fixture.request.requestId}`)).operation).toBeNull()
    fixture.database.prepare('UPDATE household_arrangement_transitions SET context = ?').run('broken private context')
    expect((await status(key, `?operationId=${fixture.request.requestId}`)).operation).toBeNull()
    expect((await status(key, `?operationId=${randomUUID()}`)).operation).toBeNull()
  })

  it('requires same-origin and the current sleeper for browser mutations', async () => {
    const headers = browserHeaders()
    for (const edited of [{ ...headers, origin: 'https://other.test' }, { ...headers, 'x-sleepypod-sleeper-id': fixture.member.selfSleeperId }]) {
      const response = await householdHttp(request('', 'POST', fixture.request, undefined, edited), dependencies)
      expect([403, 409]).toContain(response.status)
    }
    expect(fixture.readEvidence).not.toHaveBeenCalled()
    expect(fixture.admission.read().holdId).toBeNull()
  })

  it.each(['initial observation', 'suspension', 'base drain', 'final observation'] as const)('stops a stale browser during %s', async (stage) => {
    const incoming = request('', 'POST', fixture.request, undefined, browserHeaders())
    const logOut = () => {
      bindBrowserScope(incoming, 'signed_out', '')
    }
    const read = fixture.readEvidence.getMockImplementation()
    if (!read) throw new Error('Missing fixture observation reader')
    if (stage === 'initial observation') fixture.readEvidence.mockImplementationOnce(async () => {
      logOut()
      return read()
    })
    if (stage === 'final observation') fixture.readEvidence.mockImplementationOnce(read).mockImplementationOnce(async () => {
      logOut()
      return read()
    })
    if (stage === 'suspension') fixture.suspend.mockImplementationOnce(async () => {
      logOut()
    })
    if (stage === 'base drain') fixture.drainBase.mockImplementationOnce(async () => {
      logOut()
    })
    expect((await householdHttp(incoming, dependencies)).status).toBe(401)
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.admission.read().holdId).toBe(stage === 'initial observation' ? null : fixture.request.requestId)
    expect(fixture.resume).not.toHaveBeenCalled()
  })

  it('does not expose status after logout while reading the service generation', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    const incoming = request('', 'GET', undefined, undefined, browserHeaders())
    const read = fixture.readGeneration.getMockImplementation()
    if (!read) throw new Error('Missing fixture generation reader')
    fixture.readGeneration.mockImplementationOnce(async () => {
      bindBrowserScope(incoming, 'signed_out', '')
      return read()
    })
    const response = await householdHttp(incoming, dependencies)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain(fixture.request.requestId)
  })

  it('retains completed recovery but withholds its response if the browser changes during resume', async () => {
    await coordinator().activate(fixture.ownerKey, fixture.request)
    dependencies.arrangementCoordinator = fixture.restart()
    const input = fixture.recoveryRequest()
    const incoming = request('/recover', 'POST', input, undefined, browserHeaders())
    fixture.resume.mockImplementationOnce(async () => {
      bindBrowserScope(incoming, 'signed_out', '')
    })
    const response = await householdHttp(incoming, dependencies)
    expect(response.status).toBe(401)
    expect(await response.text()).not.toContain('completedAt')
    expect((await status()).operation).toMatchObject({ state: 'completed', recovery: { requestId: input.requestId } })
    expect(fixture.resume).toHaveBeenCalledTimes(1)
  })
})
