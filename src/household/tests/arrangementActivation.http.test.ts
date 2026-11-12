import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { householdHttp, type HouseholdHttpDependencies } from '../http'
import { householdSessionSchema } from '../contract'
import { arrangementIndexSchema, arrangementReviewSchema } from '../arrangementContract'
import { arrangementActivationEnabled } from '../arrangementAvailability'
import { HouseholdMaintenanceWorkspace } from '../web/maintenance'
import { PersonalWebError } from '../web/protocol'
import type { PersonalWebTransport } from '../web/client'
import { arrangementCoordinatorFixture } from './arrangementCoordinatorFixture'

let fixture: ReturnType<typeof arrangementCoordinatorFixture>, dependencies: HouseholdHttpDependencies
beforeEach(() => {
  fixture = arrangementCoordinatorFixture()
  dependencies = { store: fixture.identities, arrangementReviews: fixture.reviews,
    arrangementCoordinator: fixture.makeCoordinator(), verifySoloConfiguration: () => true }
})
afterEach(() => fixture.close())

async function response(path: string, key = fixture.ownerKey, method = 'GET', body?: unknown) {
  return householdHttp(new Request(`http://pod.test/api/v1/${path}`, { method,
    headers: { host: 'pod.test', authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), dependencies)
}
async function session(key = fixture.ownerKey) {
  const result = await response('household/session', key)
  expect(result.status).toBe(200)
  return householdSessionSchema.parse(await result.json())
}
async function review(key = fixture.ownerKey) {
  const result = await response('household/arrangement', key)
  expect(result.status).toBe(200)
  return arrangementIndexSchema.parse(await result.json()).review
}
const activation = { confirmEmptyAndAttended: true, confirmClearTemporaryActions: true,
  confirmPauseLearningAndSharedAutomations: true, acknowledgeHeldUntilRecovery: true }
const restart = { confirmEmptyAndAttended: true, acknowledgeConnectionWillClose: true, acknowledgeControlsRemainPaused: true }
const recovery = { confirmEmptyAndAttended: true, confirmAssignedSides: true, acknowledgeRecordingGap: true, acknowledgeLearningRemainsOff: true }

async function personalWorkspace() {
  const posts: string[] = []
  const read: PersonalWebTransport['read'] = async (path, method = 'GET', body) => {
    if (method === 'POST') posts.push(path)
    const result = await response(path, fixture.ownerKey, method, body)
    const payload = await result.json()
    if (!result.ok) throw new PersonalWebError(payload.error.code, payload.error.message)
    return payload
  }
  const entered = vi.fn(), finished = vi.fn(), invalidated = vi.fn()
  const workspace = new HouseholdMaintenanceWorkspace({ session: await session(), client: { read, dispose: vi.fn() },
    entered, finished, invalidated, now: () => fixture.clock.now })
  return { workspace, posts, entered, finished, invalidated }
}

describe('public attended arrangement activation', () => {
  it('requires every deployment prerequisite and an explicit activation opt-in', () => {
    const names = ['SLEEPYPOD_HOUSEHOLD_PREPARATION', 'SLEEPYPOD_PERSONAL_RUNTIME', 'SLEEPYPOD_PERSONAL_ROUTINES',
      'SLEEPYPOD_PERSONAL_HISTORY', 'SLEEPYPOD_ARRANGEMENT_REVIEW', 'SLEEPYPOD_ARRANGEMENT_ACTIVATION']
    const environment = Object.fromEntries(names.map(name => [name, '1']))
    expect(arrangementActivationEnabled(environment)).toBe(true)
    expect(arrangementActivationEnabled({})).toBe(false)
    for (const name of names) for (const value of [undefined, '0', 'true'])
      expect(arrangementActivationEnabled({ ...environment, [name]: value })).toBe(false)
  })

  it('advertises only owner activation after both independent approvals without reading or changing hardware', async () => {
    expect((await session()).capabilities).toMatchObject({ activateArrangement: true, arrangementMaintenance: true })
    expect(await review()).toMatchObject({ canActivate: true, state: 'approved_for_separate_activation' })
    expect((await session(fixture.memberKey)).capabilities).toMatchObject({ activateArrangement: false, arrangementMaintenance: false })
    expect(await review(fixture.memberKey)).toMatchObject({ canActivate: false })
    const detail = await response(`household/arrangement/${fixture.request.reviewId}`)
    expect(arrangementReviewSchema.parse(await detail.json()).canActivate).toBe(true)
    expect(fixture.events).toEqual([])
    expect(fixture.admission.read().holdId).toBeNull()
  })

  it('withdraws availability immediately when disabled, held, corrupt or already assigned', async () => {
    fixture.clock.enabled = false
    expect((await session()).capabilities.activateArrangement).toBe(false)
    expect((await review())?.canActivate).toBe(false)
    expect((await response('household/transition', fixture.ownerKey, 'POST', fixture.request)).status).toBe(409)
    expect(fixture.events).toEqual([])
    fixture.clock.enabled = true
    fixture.admission.hold(randomUUID())
    expect((await session()).capabilities.activateArrangement).toBe(false)
    expect((await review())?.canActivate).toBe(false)
    fixture.database.prepare('DELETE FROM hardware_admission').run()
    expect((await session()).capabilities.activateArrangement).toBe(false)
    expect((await review())?.canActivate).toBe(false)
  })

  it.each(['expired', 'changed_preferences', 'revoked_approval', 'cancelled'] as const)('withholds activation for a %s review', async (reason) => {
    if (reason === 'expired') fixture.clock.now += 60 * 60 * 1000
    if (reason === 'changed_preferences') {
      const saved = fixture.identities.preferences(fixture.memberKey)
      fixture.identities.updatePreferences(fixture.memberKey, { ...fixture.context(fixture.memberKey), expectedRevision: saved.revision,
        preferences: { ...saved.preferences, preferredTemperatureF: 71 } })
    }
    if (reason === 'revoked_approval') fixture.database.prepare('UPDATE household_devices SET revoked_at = ? WHERE account_id = ?')
      .run(fixture.clock.now, fixture.member.accountId)
    if (reason === 'cancelled') fixture.reviews.cancel(fixture.ownerKey, { ...fixture.context(), version: 1, reviewId: fixture.request.reviewId })
    expect((await review())?.canActivate).toBe(false)
    const result = await response('household/transition', fixture.ownerKey, 'POST', { ...fixture.request,
      issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000 })
    expect(result.status).toBe(409)
    expect(fixture.admission.read().holdId).toBeNull()
    expect(fixture.suspend).not.toHaveBeenCalled()
  })

  it('projects fresh approvals on every mutation while keeping the partner week private', async () => {
    fixture.reviews.cancel(fixture.ownerKey, { ...fixture.context(), version: 1, reviewId: fixture.request.reviewId })
    const created = await response('household/arrangement', fixture.ownerKey, 'POST', { ...fixture.context(), version: 1,
      ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
    const proposed = arrangementReviewSchema.parse(await created.json())
    expect(proposed.canActivate).toBe(false)
    for (const key of [fixture.memberKey, fixture.ownerKey]) {
      const result = await response('household/arrangement/approve', key, 'POST', { ...fixture.context(key), version: 1,
        reviewId: proposed.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000,
        confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
      expect(result.status).toBe(200)
      const saved = arrangementReviewSchema.parse(await result.json())
      expect(saved.canActivate).toBe(key === fixture.ownerKey)
      expect(Object.keys(saved.partner).sort()).toEqual(['approved', 'displayName', 'proposedSide'])
    }
    const cancelled = await response('household/arrangement/cancel', fixture.ownerKey, 'POST', {
      ...fixture.context(), version: 1, reviewId: proposed.reviewId })
    expect(arrangementReviewSchema.parse(await cancelled.json())).toMatchObject({ state: 'cancelled', canActivate: false })
  })

  it('runs the real web workspace through authenticated activation, explicit restart and verified recovery', async () => {
    const approved = await review()
    if (!approved) throw new Error('Expected independently approved review')
    const { workspace, posts, entered, finished, invalidated } = await personalWorkspace()
    await workspace.refresh()
    expect(workspace.getSnapshot().canActivate).toBe(true)
    await workspace.activate(approved, activation)
    const committed = workspace.getSnapshot().status?.operation
    expect(committed).toMatchObject({ state: 'committed', admission: 'held_for_this_transition' })
    if (!committed) throw new Error('Expected saved transition')
    fixture.request.requestId = committed.operationId
    expect((await session()).self).toMatchObject({ assignment: 'right', zones: ['right'] })
    expect((await session(fixture.memberKey)).self).toMatchObject({ assignment: 'left', zones: ['left'] })
    expect((await session()).capabilities.activateArrangement).toBe(false)
    expect(await review()).toBeNull()
    expect((await session()).capabilities.arrangementReview).toBe(false)
    expect(fixture.resume).not.toHaveBeenCalled()
    await workspace.restart(restart)
    expect(fixture.restartService).toHaveBeenCalledOnce()
    await workspace.refresh()
    await workspace.restart(restart)
    expect(fixture.restartService).toHaveBeenCalledOnce()
    dependencies.arrangementCoordinator = fixture.restart()
    await workspace.refresh()
    expect(workspace.getSnapshot().status?.operation?.controllerRestarted).toBe(true)
    await workspace.recover(recovery)
    expect(workspace.getSnapshot().status?.operation).toMatchObject({ state: 'completed', admission: 'open' })
    await workspace.returnToControls()
    expect(finished).toHaveBeenCalledOnce()
    expect(entered).toHaveBeenCalledOnce()
    expect(invalidated).not.toHaveBeenCalled()
    expect(fixture.resume).toHaveBeenCalledOnce()
    expect(posts).toEqual(['household/transition', 'household/transition/restart', 'household/transition/recover'])
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_attribution_epochs WHERE mode = \'assigned\' AND ends_at IS NULL').get())
      .toEqual({ count: 1 })
  })

  it('preserves a cancelled receipt and starts a distinct later review through the real web client', async () => {
    fixture.drainBase.mockRejectedValueOnce(new Error('interrupted'))
    expect((await response('household/transition', fixture.ownerKey, 'POST', fixture.request)).status).toBe(503)
    dependencies.arrangementCoordinator = fixture.restart(false)
    const preview = await (await response(`household/transition/cancellation-preview?operationId=${fixture.request.requestId}`)).json()
    const cancelled = await response('household/transition/cancel', fixture.ownerKey, 'POST', { ...fixture.context(),
      version: 1, operationId: fixture.request.requestId, expectedControlDigest: preview.controlDigest,
      issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000, confirmEmptyAndAttended: true,
      confirmKeepSoloArrangement: true, acknowledgeSavedRoutinesMayResume: true })
    expect(cancelled.status).toBe(200)
    expect((await review())?.state).toBe('cancelled')
    fixture.clock.now += 1
    const proposed = fixture.reviews.propose(fixture.ownerKey, { ...fixture.context(), version: 1,
      ownerSide: 'right', confirmPreserveOperatingOwnerWeek: true })
    for (const key of [fixture.ownerKey, fixture.memberKey]) fixture.reviews.approve(key, { ...fixture.context(key), version: 1,
      reviewId: proposed.reviewId, issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000,
      confirmMySide: true, confirmMyRoutine: true, acknowledgeSeparateActivation: true })
    const approved = await review()
    if (!approved) throw new Error('Expected fresh review')
    const { workspace, posts } = await personalWorkspace()
    await workspace.refresh()
    expect(workspace.getSnapshot()).toMatchObject({ entered: false, status: { operation: { state: 'cancelled' } } })
    await workspace.activate(approved, activation)
    expect(workspace.getSnapshot().status?.operation).toMatchObject({ state: 'committed', reviewId: proposed.reviewId })
    expect(workspace.getSnapshot().status?.operation?.operationId).not.toBe(fixture.request.requestId)
    expect(posts).toEqual(['household/transition'])
    const oldReceipt = await (await response(`household/transition?operationId=${fixture.request.requestId}`)).json()
    expect(oldReceipt.operation.state).toBe('cancelled')
  })
})
