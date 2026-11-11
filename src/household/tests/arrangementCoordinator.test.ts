import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { arrangementCoordinatorFixture } from './arrangementCoordinatorFixture'
import { beginHardwareWrite, captureHardwareIntent, HardwareAdmissionError, withinHardwareIntent } from '@/src/hardware/admission'

let fixture: ReturnType<typeof arrangementCoordinatorFixture>
beforeEach(() => {
  fixture = arrangementCoordinatorFixture()
})
afterEach(() => fixture.close())

describe('attended arrangement coordinator', () => {
  it('drains in order, re-observes, commits both assignments and leaves admission held for restart', async () => {
    const coordinator = fixture.makeCoordinator()
    expect(fixture.events).toEqual([])
    const result = await coordinator.activate(fixture.ownerKey, fixture.request)
    expect(result).toMatchObject({ receipt: { state: 'committed' }, recovered: false, replayed: false })
    expect(fixture.events).toEqual(['read', 'suspend', 'base', 'hardware', 'read'])
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('right')
    expect(fixture.identities.session(fixture.memberKey).self.assignment).toBe('left')
    expect(fixture.resume).not.toHaveBeenCalled()
  })
  it.each(['suspend', 'drainBase', 'drainHardware'] as const)('keeps solo settings held when %s fails', async (stage) => {
    fixture[stage].mockRejectedValueOnce(new Error('fixture interruption'))
    await expect(fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)).rejects.toThrow('interruption')
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.database.prepare('SELECT state FROM household_arrangement_transitions').get()).toEqual({ state: 'held' })
    expect(fixture.resume).not.toHaveBeenCalled()
  })
  it('rejects changed observations after the drain without committing or restarting controls', async () => {
    const read = fixture.readEvidence.getMockImplementation()
    if (!read) throw new Error('Missing fixture reader')
    fixture.readEvidence.mockImplementationOnce(read).mockImplementationOnce(async () => {
      const evidence = await read()
      evidence.observation.presence.observedAt -= 5001
      return evidence
    })
    await expect(fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)).rejects.toThrow()
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
  })
  it('does not establish a hold when initial evidence is unavailable', async () => {
    fixture.readEvidence.mockRejectedValueOnce(new Error('source unavailable'))
    await expect(fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)).rejects.toThrow('source unavailable')
    expect(fixture.admission.read().holdId).toBeNull()
    expect(fixture.suspend).not.toHaveBeenCalled()
  })
  it('does not reuse an expired confirmation after suspension takes too long', async () => {
    fixture.suspend.mockImplementationOnce(async () => {
      fixture.clock.now += 30001
    })
    await expect(fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)).rejects.toThrow('fresh attended')
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
  })
  it('shares operation exclusion across duplicate coordinator instances', async () => {
    let release!: () => void
    const read = fixture.readEvidence.getMockImplementation()
    if (!read) throw new Error('Missing fixture reader')
    fixture.readEvidence.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return read()
    })
    const pending = fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    await expect(fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)).rejects.toThrow('already being checked')
    release()
    await pending
    expect(fixture.suspend).toHaveBeenCalledTimes(1)
  })
  it('rejects partner credentials before reading sensors or suspending services', async () => {
    await expect(fixture.makeCoordinator().activate(fixture.memberKey, fixture.request)).rejects.toMatchObject({ code: 'forbidden' })
    expect(fixture.readEvidence).not.toHaveBeenCalled()
    expect(fixture.suspend).not.toHaveBeenCalled()
  })
  it('requires a new generation and both real-store processing receipts before recovery', async () => {
    const coordinator = fixture.makeCoordinator()
    await coordinator.activate(fixture.ownerKey, fixture.request)
    await expect(coordinator.recover(fixture.ownerKey, fixture.recoveryRequest())).rejects.toThrow()
    const restarted = fixture.restart(false)
    await expect(restarted.recover(fixture.ownerKey, fixture.recoveryRequest())).rejects.toThrow()
    expect(fixture.admission.read().holdId).toBe(fixture.request.requestId)
    expect(fixture.resume).not.toHaveBeenCalled()
  })
  it('releases before fresh startup and replays receipts without another read, drain or resume', async () => {
    await fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    const restarted = fixture.restart()
    const request = fixture.recoveryRequest()
    const recovered = await restarted.recover(fixture.ownerKey, request)
    expect(recovered).toMatchObject({ receipt: { state: 'completed' }, automaticServices: 'resumed', replayed: false })
    expect(fixture.admission.read().holdId).toBeNull()
    const calls = [...fixture.events]
    fixture.clock.now += 60000
    fixture.readEvidence.mockRejectedValue(new Error('later source failure'))
    fixture.clock.enabled = false
    expect(await restarted.recover(fixture.ownerKey, request)).toEqual({ receipt: recovered.receipt, automaticServices: 'unchanged_by_replay', replayed: true })
    expect(await restarted.activate(fixture.ownerKey, fixture.request)).toMatchObject({ recovered: true, replayed: true })
    expect(fixture.events).toEqual(calls)
    expect(fixture.resume).toHaveBeenCalledTimes(1)
    expect(fixture.admission.read().holdId).toBeNull()
  })
  it('does not claim automatic services resumed when fresh startup fails', async () => {
    await fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    const restarted = fixture.restart()
    fixture.resume.mockRejectedValueOnce(new Error('startup failed'))
    const result = await restarted.recover(fixture.ownerKey, fixture.recoveryRequest())
    expect(result).toMatchObject({ receipt: { state: 'completed' }, automaticServices: 'unavailable' })
    expect(fixture.admission.read().holdId).toBeNull()
    expect(fixture.suspend).toHaveBeenCalledTimes(3)
  })
  it('starts released producers outside the attended request without renewing that old request', async () => {
    await fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    const restarted = fixture.restart()
    fixture.resume.mockImplementationOnce(async () => beginHardwareWrite(captureHardwareIntent())())
    await withinHardwareIntent(async () => {
      const result = await restarted.recover(fixture.ownerKey, fixture.recoveryRequest())
      expect(result.automaticServices).toBe('resumed')
      expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    })
  })
  it('blocks new writes if a failed resume cannot drain, while preserving explicit Stop', async () => {
    await fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)
    const restarted = fixture.restart()
    fixture.resume.mockImplementationOnce(async () => {
      fixture.suspend.mockRejectedValueOnce(new Error('partial runtime stuck'))
      throw new Error('startup failed')
    })
    const result = await restarted.recover(fixture.ownerKey, fixture.recoveryRequest())
    expect(result).toMatchObject({ receipt: { state: 'completed' }, automaticServices: 'unavailable' })
    expect(fixture.admission.read().holdId).toBeNull()
    expect(() => beginHardwareWrite(captureHardwareIntent())).toThrow(HardwareAdmissionError)
    expect(() => beginHardwareWrite(captureHardwareIntent(), true)()).not.toThrow()
  })
  it('cancels an interrupted uncommitted hold after restart, preserving solo identity and history', async () => {
    fixture.drainBase.mockRejectedValueOnce(new Error('base still busy'))
    await expect(fixture.makeCoordinator().activate(fixture.ownerKey, fixture.request)).rejects.toThrow()
    const restarted = fixture.restart(false)
    const preview = restarted.cancellationPreview(fixture.ownerKey, fixture.request.requestId)
    const request = { ...fixture.context(), version: 1, operationId: fixture.request.requestId,
      issuedAt: fixture.clock.now, expiresAt: fixture.clock.now + 30000, expectedControlDigest: preview.controlDigest,
      confirmEmptyAndAttended: true, confirmKeepSoloArrangement: true, acknowledgeSavedRoutinesMayResume: true }
    const cancelled = await restarted.cancel(fixture.ownerKey, request)
    expect(cancelled).toMatchObject({ receipt: { state: 'cancelled' }, automaticServices: 'resumed', replayed: false })
    expect(fixture.identities.session(fixture.ownerKey).self.assignment).toBe('solo')
    expect(fixture.database.prepare('SELECT mode, ends_at FROM household_attribution_epochs').all()).toEqual([{ mode: 'solo_merged', ends_at: null }])
    fixture.clock.now += 60000
    expect(await restarted.cancel(fixture.ownerKey, request)).toEqual({ receipt: cancelled.receipt, automaticServices: 'unchanged_by_replay', replayed: true })
    expect(fixture.resume).toHaveBeenCalledTimes(1)
  })
})
