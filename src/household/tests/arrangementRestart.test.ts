import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { arrangementCoordinatorFixture } from './arrangementCoordinatorFixture'
import { ArrangementRestartStore } from '../arrangementRestart'
import { beginHardwareWrite, captureHardwareIntent } from '@/src/hardware/admission'

let fixture: ReturnType<typeof arrangementCoordinatorFixture>
beforeEach(() => {
  fixture = arrangementCoordinatorFixture()
})
afterEach(() => fixture.close())

describe('attended controller restart', () => {
  it('durably records the intent before submitting once and keeps controls held after submission', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    const request = fixture.restartRequest()
    fixture.restartService.mockImplementationOnce(async () => {
      const saved = new ArrangementRestartStore(fixture.database, () => fixture.clock.now).read(fixture.request.requestId)
      expect(saved?.receipt).toMatchObject({ requestId: request.requestId, state: 'requested', resultAt: null })
      expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
      expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow()
    })
    expect(await coordinator.restart(fixture.ownerKey, request)).toMatchObject({ replayed: false, receipt: { state: 'submitted', replayAllowed: false } })
    const state = await coordinator.status(fixture.ownerKey)
    expect(state.operation).toMatchObject({ state: 'committed', controllerRestarted: false,
      admission: 'held_for_this_transition', restart: { state: 'submitted' } })
    expect(fixture.resume).not.toHaveBeenCalled()
    const events = [...fixture.events]
    fixture.clock.now += 60000
    fixture.clock.enabled = false
    expect(await coordinator.restart(fixture.ownerKey, request)).toMatchObject({ replayed: true, receipt: { state: 'submitted' } })
    expect(fixture.restartService).toHaveBeenCalledTimes(1)
    expect(fixture.events).toEqual(events)
  })

  it('preserves an uncertain submission without retrying it or exposing subprocess errors', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    fixture.restartService.mockRejectedValueOnce(new Error('private diagnostic stderr'))
    const request = fixture.restartRequest()
    const result = await coordinator.restart(fixture.ownerKey, request)
    expect(result.receipt.state).toBe('unconfirmed')
    expect(JSON.stringify(result)).not.toContain('private diagnostic')
    await coordinator.restart(fixture.ownerKey, request)
    await expect(coordinator.restart(fixture.ownerKey, { ...request, requestId: randomUUID() })).rejects.toThrow('already requested')
    expect(fixture.restartService).toHaveBeenCalledTimes(1)
  })

  it('survives lost completion persistence and lets a new coordinator read the original dispatch intent', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    fixture.database.exec(`CREATE TRIGGER fail_restart_receipt BEFORE UPDATE ON household_arrangement_restarts BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`)
    const request = fixture.restartRequest()
    await expect(coordinator.restart(fixture.ownerKey, request)).rejects.toThrow('persistence failure')
    fixture.database.exec('DROP TRIGGER fail_restart_receipt')
    const reopened = fixture.makeCoordinator()
    expect(await reopened.restart(fixture.ownerKey, request)).toMatchObject({ replayed: true, receipt: { state: 'requested', resultAt: null } })
    expect(fixture.restartService).toHaveBeenCalledTimes(1)
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
  })

  it('does not dispatch when the durable intent cannot be saved', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    fixture.database.exec(`CREATE TRIGGER fail_restart_intent BEFORE INSERT ON household_arrangement_restarts BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END`)
    await expect(coordinator.restart(fixture.ownerKey, fixture.restartRequest())).rejects.toThrow('write failure')
    expect(fixture.restartService).not.toHaveBeenCalled()
    expect(fixture.database.prepare('SELECT COUNT(*) AS count FROM household_arrangement_restarts').get()).toEqual({ count: 0 })
  })

  it('can restart an interrupted uncommitted hold without committing the new assignments', async () => {
    const coordinator = fixture.makeCoordinator()
    fixture.drainBase.mockRejectedValueOnce(new Error('interrupted'))
    await expect(coordinator.activate(fixture.ownerKey, fixture.request)).rejects.toThrow()
    expect(await coordinator.restart(fixture.ownerKey, fixture.restartRequest())).toMatchObject({ receipt: { state: 'submitted' } })
    expect((await coordinator.status(fixture.ownerKey)).operation?.state).toBe('held')
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
  })

  it.each(['stale session', 'stale assignment', 'expired', 'disabled'] as const)('rejects %s before suspending services', async (condition) => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    const request = fixture.restartRequest()
    if (condition === 'stale session') request.expectedSessionRevision++
    if (condition === 'stale assignment') request.expectedAssignmentRevision++
    if (condition === 'expired') fixture.clock.now += 30001
    if (condition === 'disabled') fixture.clock.enabled = false
    const events = [...fixture.events]
    await expect(coordinator.restart(fixture.ownerKey, request)).rejects.toThrow()
    expect(fixture.events.slice(events.length)).not.toContain('suspend')
    expect(fixture.restartService).not.toHaveBeenCalled()
  })

  it('does not suspend or restart an already recovered arrangement', async () => {
    await fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    const restarted = fixture.restart()
    await restarted.recover(fixture.ownerKey, fixture.recoveryRequest())
    const events = [...fixture.events]
    await expect(restarted.restart(fixture.ownerKey, fixture.restartRequest())).rejects.toThrow('current transition')
    expect(fixture.events.slice(events.length)).not.toContain('suspend')
    expect(fixture.restartService).not.toHaveBeenCalled()
  })

  it('rejects a second restart after a new controller generation is already observed', async () => {
    await fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    const restarted = fixture.restart()
    const events = [...fixture.events]
    await expect(restarted.restart(fixture.ownerKey, fixture.restartRequest())).rejects.toThrow('already observed')
    expect(fixture.events.slice(events.length)).not.toContain('suspend')
    expect(fixture.restartService).not.toHaveBeenCalled()
  })

  it('rechecks attendance expiry after draining', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    fixture.drainBase.mockImplementationOnce(async () => {
      fixture.clock.now += 30001
    })
    await expect(coordinator.restart(fixture.ownerKey, fixture.restartRequest())).rejects.toThrow()
    expect(fixture.restartService).not.toHaveBeenCalled()
    expect((await coordinator.status(fixture.ownerKey)).operation?.restart).toBeNull()
  })

  it('does not expose a fabricated restart receipt from changed saved controller evidence', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    await coordinator.restart(fixture.ownerKey, fixture.restartRequest())
    const row = fixture.database.prepare('SELECT controller FROM household_arrangement_restarts').get() as { controller: string }
    const controller = JSON.parse(row.controller)
    controller.invocationId = 'c'.repeat(32)
    fixture.database.prepare('UPDATE household_arrangement_restarts SET controller = ?').run(JSON.stringify(controller))
    await expect(coordinator.status(fixture.ownerKey)).rejects.toThrow()
  })
})
