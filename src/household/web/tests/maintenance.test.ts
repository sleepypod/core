import { describe, expect, it, vi } from 'vitest'
import preparation from '../../fixtures/preparation-v1.json'
import reviewExample from '../../fixtures/arrangement-review-v1.json'
import { householdSessionSchema } from '../../contract'
import { arrangementReviewSchema } from '../../arrangementContract'
import { arrangementMaintenanceStatusSchema } from '../../arrangementMaintenanceContract'
import { HouseholdMaintenanceWorkspace } from '../maintenance'
import { PersonalWebError } from '../protocol'
import { maintenancePathAllowed, readMaintenanceStatus } from '../maintenanceProtocol'
import type { PersonalWebTransport } from '../client'

const operationId = '10000000-0000-4000-8000-000000000088'
const requestId = '10000000-0000-4000-8000-000000000089'
const activation = { confirmEmptyAndAttended: true, confirmClearTemporaryActions: true,
  confirmPauseLearningAndSharedAutomations: true, acknowledgeHeldUntilRecovery: true }
const restart = { confirmEmptyAndAttended: true, acknowledgeConnectionWillClose: true, acknowledgeControlsRemainPaused: true }
const recovery = { confirmEmptyAndAttended: true, confirmAssignedSides: true, acknowledgeRecordingGap: true, acknowledgeLearningRemainsOff: true }
const cancellation = { confirmEmptyAndAttended: true, confirmKeepSoloArrangement: true, acknowledgeSavedRoutinesMayResume: true }

function setup(initial: 'empty' | 'held' | 'committed' = 'committed') {
  let now = reviewExample.ownerReview.createdAt + 2000
  const session = householdSessionSchema.parse(preparation.ownerSession)
  session.capabilities.activateArrangement = true
  const review = arrangementReviewSchema.parse({ ...reviewExample.ownerReview, state: 'approved_for_separate_activation',
    canActivate: true, canApprove: false, self: { ...reviewExample.ownerReview.self, approved: true }, partner: { ...reviewExample.ownerReview.partner, approved: true } })
  const status = arrangementMaintenanceStatusSchema.parse({ version: 1, observedAt: now,
    expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision,
    operation: initial === 'empty'
      ? null
      : { operationId, reviewId: review.reviewId, state: initial, createdAt: now - 1000,
          committedAt: initial === 'committed' ? now - 500 : null, controllerRestarted: false,
          admission: 'held_for_this_transition', recovery: null, cancellation: null, restart: null } })
  const posts: Array<{ path: string, body: Record<string, unknown> }> = []
  const entered = vi.fn(), invalidated = vi.fn(), finished = vi.fn()
  let failure: string | null = null
  const preview = () => ({ operationId: status.operation?.operationId, expectedSessionRevision: session.sessionRevision,
    expectedAssignmentRevision: session.assignmentRevision, observedAt: now, controlDigest: 'a'.repeat(64) })
  const read: PersonalWebTransport['read'] = async (path, method = 'GET', input) => {
    if (path === 'household/session') return structuredClone(session)
    if (path === 'household/arrangement') return { version: 1, review: structuredClone(review) }
    if (path.startsWith('household/transition/cancellation-preview')) return preview()
    if (method === 'GET') return structuredClone(status)
    const body = input as Record<string, unknown>
    posts.push({ path, body })
    if (failure) throw new PersonalWebError(failure, 'Network result was not confirmed.')
    if (path === 'household/transition') {
      session.assignmentRevision++
      session.sessionRevision++
      session.arrangement.mode = 'assigned'
      session.self.assignment = 'right'
      session.self.zones = ['right']
      status.expectedAssignmentRevision = session.assignmentRevision
      status.expectedSessionRevision = session.sessionRevision
      status.operation = { operationId: String(body.requestId), reviewId: review.reviewId, state: 'committed',
        createdAt: now, committedAt: now, controllerRestarted: false, admission: 'held_for_this_transition', recovery: null, cancellation: null, restart: null }
      return { receipt: { operationId: body.requestId, reviewId: review.reviewId, state: 'committed', createdAt: now, committedAt: now,
        hardware: 'held_for_runtime_recovery', admissionRevision: 2 }, recovered: false, replayed: false }
    }
    if (!status.operation) throw new Error('Missing fixture operation')
    if (path.endsWith('/restart')) {
      status.operation.restart = { operationId: status.operation.operationId, requestId: String(body.requestId), state: 'submitted',
        requestedAt: now, resultAt: now, hardware: 'held_for_runtime_recovery', replayAllowed: false }
      return { receipt: status.operation.restart, replayed: false }
    }
    if (path.endsWith('/recover')) {
      status.operation.state = 'completed'
      status.operation.admission = 'open'
      status.operation.recovery = { operationId: status.operation.operationId, requestId: String(body.requestId), reviewId: review.reviewId,
        state: 'completed', completedAt: now, admissionRevision: 3, epochId: requestId, recordingStartsAt: now,
        hardware: 'admission_released', physicalMovement: 'not_requested' }
      return { receipt: status.operation.recovery, replayed: false, automaticServices: 'resumed' }
    }
    status.operation.state = 'cancelled'
    status.operation.admission = 'open'
    status.operation.cancellation = { operationId: status.operation.operationId, requestId: String(body.requestId), reviewId: review.reviewId,
      state: 'cancelled', completedAt: now, admissionRevision: 3, controlDigest: String(body.expectedControlDigest), arrangement: 'solo-anywhere',
      hardware: 'admission_released', physicalMovement: 'not_requested' }
    return { receipt: status.operation.cancellation, replayed: false, automaticServices: 'unavailable' }
  }
  const client = { read: vi.fn(read), dispose: vi.fn() }
  const workspace = new HouseholdMaintenanceWorkspace({ session: structuredClone(session), client, entered, invalidated, finished, now: () => now })
  return { workspace, client, entered, invalidated, finished, status, session, review, posts, read, preview,
    operation: () => {
      if (!status.operation) throw new Error('Missing fixture operation')
      return status.operation
    },
    advance: (milliseconds: number) => {
      now += milliseconds
      status.observedAt = now
    }, fail: (code: string | null) => { failure = code } }
}

describe('attended personal web maintenance', () => {
  it('reads a pending operation without writes, and enters maintenance only once', async () => {
    const fixture = setup()
    await fixture.workspace.refresh()
    await fixture.workspace.refresh()
    expect(fixture.posts).toEqual([])
    expect(fixture.entered).toHaveBeenCalledOnce()
    expect(fixture.workspace.getSnapshot()).toMatchObject({ loaded: true, entered: true, status: fixture.status })
  })
  it('requires a fresh read and every explicit restart confirmation', async () => {
    const fixture = setup()
    await fixture.workspace.restart(restart)
    expect(fixture.posts).toEqual([])
    for (const field of Object.keys(restart)) {
      await fixture.workspace.refresh()
      await fixture.workspace.restart({ ...restart, [field]: false })
    }
    expect(fixture.posts).toEqual([])
    await fixture.workspace.refresh()
    await fixture.workspace.restart(restart)
    expect(fixture.posts).toHaveLength(1)
    expect(fixture.posts[0].body).toMatchObject({ ...restart, operationId })
    expect(fixture.workspace.getSnapshot()).toMatchObject({ loaded: false, message: expect.stringContaining('controls stay paused') })
    await fixture.workspace.restart(restart)
    await fixture.workspace.refresh()
    await fixture.workspace.restart(restart)
    expect(fixture.posts).toHaveLength(1)
  })
  it.each(['uncertain', 'unavailable'])('never resends a %s restart after reconnect', async (code) => {
    const fixture = setup()
    await fixture.workspace.refresh()
    fixture.fail(code)
    await fixture.workspace.restart(restart)
    await fixture.workspace.restart(restart)
    expect(fixture.posts).toHaveLength(1)
    fixture.operation().restart = { operationId, requestId, state: 'requested', requestedAt: fixture.status.observedAt,
      resultAt: null, hardware: 'held_for_runtime_recovery', replayAllowed: false }
    await fixture.workspace.refresh()
    await fixture.workspace.restart(restart)
    expect(fixture.posts).toHaveLength(1)
    expect(fixture.workspace.getSnapshot().status?.operation?.restart?.state).toBe('requested')
  })
  it('preserves account identity while reacquiring revisions after its own committed activation', async () => {
    const fixture = setup('empty')
    await fixture.workspace.refresh()
    await fixture.workspace.activate(fixture.review, activation)
    expect(fixture.posts).toHaveLength(1)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ loaded: true, entered: true, status: { expectedAssignmentRevision: 2,
      operation: { state: 'committed', controllerRestarted: false } } })
    expect(fixture.invalidated).not.toHaveBeenCalled()
    expect(fixture.entered).toHaveBeenCalledOnce()
  })
  it.each(['capability', 'approval', 'confirmation'])('does not activate without %s', async (missing) => {
    const fixture = setup('empty')
    if (missing === 'capability') fixture.session.capabilities.activateArrangement = false
    if (missing === 'approval') fixture.review.canActivate = false
    await fixture.workspace.refresh()
    await fixture.workspace.activate(fixture.review, { ...activation, acknowledgeHeldUntilRecovery: missing !== 'confirmation' })
    expect(fixture.posts).toEqual([])
  })
  it('requires a verified new controller before recovery and reports completion separately from movement', async () => {
    const fixture = setup()
    await fixture.workspace.refresh()
    await fixture.workspace.recover(recovery)
    expect(fixture.posts).toEqual([])
    fixture.operation().controllerRestarted = true
    await fixture.workspace.refresh()
    await fixture.workspace.recover(recovery)
    expect(fixture.posts).toHaveLength(1)
    expect(fixture.workspace.getSnapshot().status?.operation).toMatchObject({ state: 'completed',
      recovery: { physicalMovement: 'not_requested' } })
    await fixture.workspace.recover(recovery)
    expect(fixture.posts).toHaveLength(1)
  })
  it('requires a current cancellation preview and keeps routine startup uncertainty visible', async () => {
    const fixture = setup('held')
    fixture.operation().controllerRestarted = true
    await fixture.workspace.refresh()
    await fixture.workspace.cancel(cancellation)
    expect(fixture.posts).toEqual([])
    await fixture.workspace.previewCancellation()
    fixture.advance(60_001)
    await fixture.workspace.cancel(cancellation)
    expect(fixture.posts).toEqual([])
    await fixture.workspace.refresh()
    await fixture.workspace.previewCancellation()
    await fixture.workspace.cancel(cancellation)
    expect(fixture.posts).toHaveLength(1)
    expect(fixture.workspace.getSnapshot()).toMatchObject({ status: { operation: { state: 'cancelled' } },
      message: expect.stringContaining('startup is not confirmed') })
  })
  it('withholds cancellation until a new controller is verified', async () => {
    const fixture = setup('held')
    await fixture.workspace.refresh()
    await fixture.workspace.previewCancellation()
    expect(fixture.workspace.getSnapshot().cancellation).toBeNull()
    expect(fixture.client.read.mock.calls.some(([path]) => path.includes('cancellation-preview'))).toBe(false)
    fixture.operation().controllerRestarted = true
    await fixture.workspace.refresh()
    await fixture.workspace.previewCancellation()
    fixture.operation().controllerRestarted = false
    await fixture.workspace.cancel(cancellation)
    expect(fixture.posts).toEqual([])
  })
  it('reopens ordinary controls only after a fresh completed and open status', async () => {
    const fixture = setup()
    await fixture.workspace.refresh()
    await fixture.workspace.returnToControls()
    expect(fixture.finished).not.toHaveBeenCalled()
    fixture.operation().controllerRestarted = true
    await fixture.workspace.refresh()
    await fixture.workspace.recover(recovery)
    const before = fixture.client.read.mock.calls.length
    await fixture.workspace.returnToControls()
    expect(fixture.client.read.mock.calls.length).toBeGreaterThan(before)
    expect(fixture.finished).toHaveBeenCalledOnce()
    fixture.finished.mockClear()
    fixture.operation().admission = 'held_for_another_transition'
    await fixture.workspace.returnToControls()
    expect(fixture.finished).not.toHaveBeenCalled()
  })
  it.each(['accountId', 'selfSleeperId'] as const)('clears private state on a changed %s', async (field) => {
    const fixture = setup()
    await fixture.workspace.refresh()
    fixture.session[field] = requestId
    await fixture.workspace.refresh()
    expect(fixture.workspace.getSnapshot().status).toBeNull()
    expect(fixture.invalidated).toHaveBeenCalledOnce()
    expect(fixture.client.dispose).toHaveBeenCalledOnce()
    expect(fixture.posts).toEqual([])
  })
  it('withdraws a status if session revisions change while its request is in flight', async () => {
    const fixture = setup()
    fixture.client.read.mockImplementation(async (path, method, body) => {
      const result = await fixture.read(path, method, body)
      if (path.startsWith('household/transition')) fixture.session.sessionRevision++
      return result
    })
    await fixture.workspace.refresh()
    expect(fixture.workspace.getSnapshot()).toMatchObject({ loaded: false, status: null })
    expect(fixture.posts).toEqual([])
  })
  it('cancels preflight on background or disposal and ignores a late reply', async () => {
    for (const finish of ['clear', 'dispose'] as const) {
      const fixture = setup()
      let resolve!: (value: unknown) => void
      fixture.client.read.mockImplementationOnce(() => new Promise((value) => {
        resolve = value
      }))
      const pending = fixture.workspace.refresh()
      fixture.workspace[finish]()
      resolve(fixture.session)
      await pending
      expect(fixture.client.read).toHaveBeenCalledTimes(1)
      expect(fixture.workspace.getSnapshot()).toMatchObject({ loaded: false, status: null })
    }
  })
  it('does not queue a second action while a status read is pending', async () => {
    const fixture = setup()
    let resolve!: (value: unknown) => void
    fixture.client.read.mockImplementationOnce(() => new Promise((value) => {
      resolve = value
    }))
    const pending = fixture.workspace.refresh()
    await fixture.workspace.refresh()
    await fixture.workspace.restart(restart)
    expect(fixture.client.read).toHaveBeenCalledOnce()
    resolve(fixture.session)
    await pending
    expect(fixture.posts).toEqual([])
  })
})

describe('maintenance transport and receipts', () => {
  it('allows only exact private maintenance paths, methods and query shapes', () => {
    expect(maintenancePathAllowed('household/transition', 'GET', undefined)).toBe(true)
    expect(maintenancePathAllowed(`household/transition?operationId=${operationId}`, 'GET', undefined)).toBe(true)
    expect(maintenancePathAllowed(`household/transition/cancellation-preview?operationId=${operationId}`, 'GET', undefined)).toBe(true)
    for (const suffix of ['', '/restart', '/recover', '/cancel']) expect(maintenancePathAllowed(`household/transition${suffix}`, 'POST', {})).toBe(true)
    for (const path of ['household/transition/restart', 'household/transition/cancel', 'household/transition/cancellation-preview',
      'household/transition?', 'household/transition?operationId=invalid', `household/transition?operationId=${operationId}&side=left`,
      `household/transition?operationId=${operationId}&operationId=${operationId}`, `household/transition?operationId=${operationId}#secret`])
      expect(maintenancePathAllowed(path, 'GET', undefined)).toBe(false)
    expect(maintenancePathAllowed('household/transition', 'GET', {})).toBe(false)
    expect(maintenancePathAllowed('household/transition', 'PUT', {})).toBe(false)
    expect(maintenancePathAllowed('household/transition?side=left', 'POST', {})).toBe(false)
  })
  it.each(['old', 'future', 'revision', 'operation', 'completion', 'commit time', 'restart time'])('rejects inconsistent %s status', (kind) => {
    const fixture = setup(), status = structuredClone(fixture.status), now = status.observedAt
    if (!status.operation) throw new Error('Missing fixture operation')
    if (kind === 'old') status.observedAt -= 15_001
    if (kind === 'future') status.observedAt++
    if (kind === 'revision') status.expectedAssignmentRevision++
    if (kind === 'operation') status.operation.operationId = requestId
    if (kind === 'completion') status.operation.state = 'completed'
    if (kind === 'commit time') status.operation.committedAt = status.operation.createdAt - 1
    if (kind === 'restart time') status.operation.restart = { operationId, requestId, state: 'requested', requestedAt: now + 1,
      resultAt: null, hardware: 'held_for_runtime_recovery', replayAllowed: false }
    expect(() => readMaintenanceStatus(status, fixture.session, now, operationId)).toThrow()
  })
})
