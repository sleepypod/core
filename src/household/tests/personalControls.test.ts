import { randomBytes, randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { beforeControlWrite } from '@/src/controls/context'
import { createControlStore, ControlConflictError } from '@/src/controls/store'
import { HouseholdStore, HouseholdError, type HouseholdCredential } from '../store'
import { PersonalControlService, type PersonalControlAuthority } from '../personalControls'
import { personalControlReceiptSchema, type PersonalControlRequest } from '../controlContract'
import type { ControlAction } from '@/src/controls/contract'

let database: Database.Database, identities: HouseholdStore, now: number, monotonic: number
let ownerKey: string, memberKey: string, memberAssigned: boolean, assignmentRevision: number, configurationRevision: string
let controller: PersonalControlService
let execute: ReturnType<typeof vi.fn<(action: ControlAction) => Promise<void>>>
const secret = () => randomBytes(32).toString('base64url')
const context = () => ({ requestId: randomUUID(), expectedSessionRevision: 1, expectedAssignmentRevision: 1 })
function authenticate(credential: HouseholdCredential) {
  const session = identities.session(credential)
  return { accountId: session.accountId, podId: session.podId, householdId: session.householdId, sleeperId: session.selfSleeperId }
}
function authorize(credential: HouseholdCredential): PersonalControlAuthority {
  const session = identities.session(credential)
  if (!memberAssigned && session.role !== 'owner') throw new HouseholdError('forbidden', 403, 'No assigned bed zone')
  return { scope: { podId: session.podId, householdId: session.householdId, sleeperId: session.selfSleeperId,
    sessionRevision: session.sessionRevision, assignmentRevision, configurationRevision },
  zones: memberAssigned ? [session.role === 'owner' ? 'right' : 'left'] : ['left', 'right'] }
}
function request(key = ownerKey): PersonalControlRequest {
  return { version: 1, requestId: randomUUID(), scope: authorize(key).scope, issuedAt: now, expiresAt: now + 30_000,
    action: { kind: 'temperature', temperatureF: 70, holdMinutes: 30 } }
}
function makeController(runId = 'test-process') {
  return new PersonalControlService({ database, runId, authenticate, authorize,
    execute: action => execute(action), now: () => now, monotonicNow: () => monotonic })
}
beforeEach(() => {
  database = migratedComfortDatabase()
  database.pragma('foreign_keys=ON')
  now = Date.parse('2026-10-29T22:00:00Z')
  monotonic = 100
  identities = new HouseholdStore(database, () => now)
  ownerKey = secret()
  memberKey = secret()
  memberAssigned = false
  assignmentRevision = 1
  configurationRevision = 'a'.repeat(64)
  identities.setup({ requestId: randomUUID(), displayName: 'Owner', deviceName: 'Phone', deviceSecret: ownerKey,
    currentMode: 'solo-anywhere', sourceSide: 'left', acknowledgeExistingOwner: true })
  const invitation = identities.createInvitation(ownerKey, { ...context(), kind: 'new_person', invitation: secret(), expiresInMinutes: 30 })
  identities.join({ invitation: invitation.invitation, deviceName: 'Partner phone', deviceSecret: memberKey, displayName: 'Partner' })
  execute = vi.fn(async () => {
    beforeControlWrite()
  })
  controller = makeController()
})
afterEach(() => {
  database.close()
  vi.restoreAllMocks()
})

describe('person-scoped command authority', () => {
  it.each(['left', 'right'] as const)('does not acknowledge both zones when %s was superseded without a write', async (skippedSide) => {
    execute.mockImplementation(async (action) => {
      if ('side' in action && action.side !== skippedSide) beforeControlWrite()
    })
    const input = request()
    expect(await controller.submit(ownerKey, input)).toMatchObject({ state: 'unknown', dispatchCount: 1 })
    expect(await controller.submit(ownerKey, input)).toMatchObject({ state: 'unknown', replayAllowed: false })
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it('reports no dispatch if both zones were superseded without a write', async () => {
    execute.mockImplementation(async () => {})
    expect(await controller.submit(ownerKey, request())).toMatchObject({ state: 'not_dispatched', dispatchCount: 0 })
  })

  it('rechecks browser request authority before a queued write and before returning its private receipt', async () => {
    let browserCurrent = true
    const assertRequestCurrent = () => {
      if (!browserCurrent) throw new HouseholdError('authentication_required', 401, 'Browser changed')
    }
    execute.mockImplementationOnce(async () => {
      browserCurrent = false
      beforeControlWrite()
    })
    const input = request()
    await expect(controller.submit(ownerKey, input, assertRequestCurrent)).rejects.toThrow('Browser changed')
    expect(controller.get(ownerKey, input.requestId)).toMatchObject({ state: 'rejected', dispatchCount: 0 })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('withholds the private response after a browser change even when the earlier write was acknowledged', async () => {
    let browserCurrent = true
    const input = request()
    execute.mockImplementation(async () => {
      beforeControlWrite()
      browserCurrent = false
    })
    await expect(controller.submit(ownerKey, input, () => {
      if (!browserCurrent) throw new HouseholdError('authentication_required', 401, 'Browser changed')
    })).rejects.toThrow('Browser changed')
    expect(controller.get(ownerKey, input.requestId)).toMatchObject({ state: 'unknown', dispatchCount: 1 })
  })

  it('targets both approved solo zones and isolates its durable receipt from legacy lookup', async () => {
    const input = request()
    const receipt = personalControlReceiptSchema.parse(await controller.submit(ownerKey, input))
    expect(receipt).toMatchObject({ state: 'acknowledged', dispatchCount: 2, action: input.action,
      resolvedZones: ['left', 'right'], physicalVerification: 'unverified', replayAllowed: false })
    expect(execute.mock.calls.map(([action]) => action)).toEqual([
      { kind: 'temperature', side: 'left', temperature: 70, holdMinutes: 30 },
      { kind: 'temperature', side: 'right', temperature: 70, holdMinutes: 30 },
    ])
    expect(createControlStore(database).get(input.requestId)).toBeUndefined()
    expect(controller.get(memberKey, input.requestId)).toBeNull()
  })
  it('does not turn a new member invitation into control authority', async () => {
    const input = { ...request(), scope: { ...request().scope, sleeperId: identities.session(memberKey).selfSleeperId } }
    await expect(controller.submit(memberKey, input)).rejects.toThrow('No assigned bed zone')
    expect(execute).not.toHaveBeenCalled()
    expect(database.prepare('SELECT COUNT(*) AS count FROM household_control_receipts').get()).toEqual({ count: 0 })
  })
  it('resolves the assigned partner zone server-side, never from a client side selector', async () => {
    memberAssigned = true
    assignmentRevision++
    const input = request(memberKey)
    expect(await controller.submit(memberKey, input)).toMatchObject({ resolvedZones: ['left'], dispatchCount: 1 })
    expect(execute.mock.calls[0][0]).toMatchObject({ side: 'left' })
    await expect(controller.submit(memberKey, { ...input, requestId: randomUUID(), action: { ...input.action, side: 'right' } })).rejects.toThrow()
    await expect(controller.submit(memberKey, { ...input, requestId: randomUUID(), action: { kind: 'base.position', head: 10, feet: 0 } })).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it.each(['podId', 'householdId', 'sleeperId', 'sessionRevision', 'assignmentRevision', 'configurationRevision'] as const)(
    'rejects a stale or foreign %s before claiming or executing', async (field) => {
      const input = request()
      const value = field === 'configurationRevision' ? 'b'.repeat(64) : field.endsWith('Revision') ? 2 : randomUUID()
      await expect(controller.submit(ownerKey, { ...input, scope: { ...input.scope, [field]: value } })).rejects.toThrow('configuration changed')
      expect(execute).not.toHaveBeenCalled()
      expect(controller.get(ownerKey, input.requestId)).toBeNull()
    })
  it('recovers the original receipt after a side move without replaying on the new side', async () => {
    const input = request()
    const receipt = await controller.submit(ownerKey, input)
    memberAssigned = true
    assignmentRevision++
    expect(await controller.submit(ownerKey, input)).toEqual(receipt)
    expect(controller.get(ownerKey, input.requestId)).toEqual(receipt)
    expect(execute).toHaveBeenCalledTimes(2)
    await expect(controller.submit(ownerKey, { ...input, scope: authorize(ownerKey).scope })).rejects.toBeInstanceOf(ControlConflictError)
    await expect(controller.submit(ownerKey, { ...input, requestId: randomUUID() })).rejects.toThrow('configuration changed')
  })
  it('rejects another account reusing a known request ID without exposing the receipt', async () => {
    const input = request()
    await controller.submit(ownerKey, input)
    memberAssigned = true
    await expect(controller.submit(memberKey, { ...input, scope: authorize(memberKey).scope })).rejects.toThrow('unavailable to your account')
    expect(controller.get(memberKey, input.requestId)).toBeNull()
  })
  it('rechecks assignment after a queue wait and denies the actual hardware write', async () => {
    const queued = Promise.withResolvers<undefined>()
    const wrote = vi.fn()
    execute.mockImplementation(async () => {
      await queued.promise
      beforeControlWrite()
      wrote()
    })
    const input = request(), pending = controller.submit(ownerKey, input)
    assignmentRevision++
    memberAssigned = true
    queued.resolve(undefined)
    expect(await pending).toMatchObject({ state: 'rejected', dispatchCount: 0 })
    expect(wrote).not.toHaveBeenCalled()
  })
  it('stops between zones when configuration changes, reporting a partial dispatch as unknown', async () => {
    execute.mockImplementation(async () => {
      beforeControlWrite()
      configurationRevision = 'b'.repeat(64)
    })
    const input = request()
    const receipt = await controller.submit(ownerKey, input)
    expect(receipt).toMatchObject({ state: 'unknown', dispatchCount: 1, resolvedZones: ['left', 'right'] })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(await controller.submit(ownerKey, input)).toEqual(receipt)
  })
  it('does not return private output after revocation during a queued write', async () => {
    const queued = Promise.withResolvers<undefined>()
    execute.mockImplementation(async () => {
      await queued.promise
      beforeControlWrite()
    })
    const input = request(), pending = controller.submit(ownerKey, input)
    database.prepare('UPDATE household_devices SET revoked_at = ? WHERE id = ?').run(now, identities.deviceIdentity(ownerKey))
    queued.resolve(undefined)
    await expect(pending).rejects.toThrow('revoked')
    expect(() => controller.get(ownerKey, input.requestId)).toThrow('revoked')
    expect(database.prepare('SELECT state, dispatch_count FROM household_control_receipts').get()).toEqual({ state: 'rejected', dispatch_count: 0 })
  })
  it.each(['expired', 'future', 'monotonic', 'rollback'] as const)('rejects %s commands and never replays them later', async (mode) => {
    const input = request()
    if (mode === 'expired') now = input.expiresAt
    if (mode === 'future') now = input.issuedAt - 1
    if (mode === 'monotonic' || mode === 'rollback') execute.mockImplementation(async () => {
      if (mode === 'monotonic') monotonic += 30000
      else now = input.issuedAt - 1
      beforeControlWrite()
    })
    const receipt = await controller.submit(ownerKey, input)
    expect(receipt).toMatchObject({ state: mode === 'future' ? 'rejected' : 'expired', dispatchCount: 0 })
    now = input.issuedAt + 100
    expect(await controller.submit(ownerKey, input)).toEqual(receipt)
  })
  it('coalesces duplicate in-flight submissions and preserves intent before dispatch', async () => {
    const queued = Promise.withResolvers<undefined>()
    const input = request()
    execute.mockImplementation(async () => {
      expect(database.prepare('SELECT state FROM household_control_receipts WHERE request_id = ?').get(input.requestId)).toEqual({ state: 'executing' })
      await queued.promise
      beforeControlWrite()
    })
    const pending = controller.submit(ownerKey, input)
    expect(await controller.submit(ownerKey, input)).toMatchObject({ state: 'executing', dispatchCount: 0 })
    queued.resolve(undefined)
    const receipt = await pending
    expect(await controller.submit(ownerKey, input)).toEqual(receipt)
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('reports interrupted work after restart as unknown and never resumes it', async () => {
    const input = request()
    await controller.submit(ownerKey, input)
    database.prepare('UPDATE household_control_receipts SET state=\'executing\', finished_at=NULL WHERE request_id=?').run(input.requestId)
    const restarted = makeController('new-process')
    expect(await restarted.submit(ownerKey, input)).toMatchObject({ state: 'unknown', reason: 'execution_interrupted', replayAllowed: false })
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('preserves its no-replay barrier if the completion receipt cannot be committed', async () => {
    const input = request()
    database.exec(`CREATE TRIGGER fail_personal_finish BEFORE UPDATE OF finished_at ON household_control_receipts
      WHEN NEW.finished_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END`)
    await expect(controller.submit(ownerKey, input)).rejects.toThrow('storage unavailable')
    expect(controller.get(ownerKey, input.requestId)).toMatchObject({ state: 'unknown', dispatchCount: 2 })
    database.exec('DROP TRIGGER fail_personal_finish')
    expect(await makeController('new-process').submit(ownerKey, input)).toMatchObject({ state: 'unknown', replayAllowed: false })
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('commits intent and each dispatch with FULL sync, and leaves no plaintext credentials', async () => {
    const pragma = vi.spyOn(database, 'pragma')
    await controller.submit(ownerKey, request())
    expect(pragma.mock.calls.filter(([value]) => value === 'synchronous = FULL')).toHaveLength(4)
    const stored = JSON.stringify(database.prepare('SELECT * FROM household_control_receipts').all())
    expect(stored).not.toContain(ownerKey)
    expect(stored).not.toContain(memberKey)
  })
  it('lets another active device of the same person reconcile an old receipt after device revocation', async () => {
    const input = request()
    const receipt = await controller.submit(ownerKey, input)
    const invitation = identities.createInvitation(ownerKey, { ...context(), kind: 'own_device', invitation: secret(), expiresInMinutes: 30 })
    const tablet = secret()
    identities.join({ invitation: invitation.invitation, deviceName: 'Owner tablet', deviceSecret: tablet, displayName: 'Owner' })
    identities.revokeDevice(tablet, { ...context(), deviceId: identities.deviceIdentity(ownerKey) })
    expect(controller.get(tablet, input.requestId)).toEqual(receipt)
    expect(() => controller.get(ownerKey, input.requestId)).toThrow('revoked')
    expect(execute).toHaveBeenCalledTimes(2)
  })
  it('retains per-person stop receipts and refuses empty or repeated authority zones', async () => {
    const input = { ...request(), action: { kind: 'vibration.clear' as const } }
    expect(await controller.submit(ownerKey, input)).toMatchObject({ action: { kind: 'vibration.clear' }, dispatchCount: 2 })
    const invalid = new PersonalControlService({ database, runId: 'invalid', authenticate,
      authorize: credential => ({ ...authorize(credential), zones: ['left', 'left'] }), execute })
    await expect(invalid.submit(ownerKey, request())).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(2)
  })
})
