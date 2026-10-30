import { expect, it, vi } from 'vitest'
import { withSideLock } from '@/src/hardware/sideLock'
import { beforeControlWrite } from '@/src/controls/context'
import { TemperatureController } from '@/src/temperature/controller'
import { createTemperatureApplicationRecorder } from '@/src/temperature/applications'
import { ComfortApplicationAdapter } from '../application'
import { ComfortRuntime } from '../runtime'
import { ownerFixture } from './ownerFixture'

it('connects owner review, runtime learning and the single authority without creating Preview actions and withdraws consent on Stop', async () => {
  const fixture = ownerFixture()
  try {
    const { owner, store, context, database } = fixture
    await fixture.ready()
    fixture.refresh(fixture.now() + 6 * 3_600_000 + 1)
    context.device.powered = true
    context.device.offConfirmed = false
    context.device.targetF = 75
    context.window = { session: 'synthetic-current-night', segment: 'first', baselineF: 75, start: fixture.now() - 1000,
      end: fixture.now() + 8 * 3_600_000, alarmAt: null }
    fixture.configure({ offsetF: -2 })
    const applied = vi.fn(async (_side: unknown, target: number) => {
      beforeControlWrite()
      context.device.targetF = target
    })
    const authority = new TemperatureController({
      now: fixture.now, withSideLock, readHold: () => null, writeHold: () => {},
      readBaseline: () => [{ id: 'routine', source: 'schedule', temperature: 75, startsAt: fixture.now() - 1000,
        expiresAt: fixture.now() + 8 * 3_600_000, createdAt: fixture.now() - 1000, priority: 0 }],
      isPowered: () => true, readCurrentTarget: () => context.device.targetF,
      readHardwareDeadline: () => null, writeHardwareDeadline: () => {}, isBlocked: () => false,
      connect: async () => {}, powerOff: async () => {}, publish: () => {}, apply: applied,
      recordApplication: createTemperatureApplicationRecorder(database, fixture.now),
    })
    const adapter = new ComfortApplicationAdapter({ now: fixture.now, monotonicNow: () => 1000,
      store, authority, withSideLock, autopilotEnabled: fixture.deps.autopilotEnabled, admission: owner.admission,
      pendingPause: () => null, readContext: () => context })
    const runtime = new ComfortRuntime({
      now: fixture.now, store, withSideLock, timezone: () => 'America/Los_Angeles',
      pendingPause: () => null, acknowledgePause: () => {}, readContext: () => ({ context, timezone: 'America/Los_Angeles' }),
      activation: { admitted: (side, state) => owner.admission(side, state) !== null,
        revoke: owner.revoke, revokeLease: side => adapter.revoke(side), reconcile: side => adapter.reconcile(side) },
    })
    await runtime.evaluate('left')
    expect(applied).not.toHaveBeenCalled()
    const review = await owner.prepare({ side: 'left', purpose: 'activation', kind: null })
    await owner.confirm({ side: 'left', id: review.id, confirmed: true, note: 'Synthetic activation' })
    await runtime.evaluate('left')
    expect(applied).toHaveBeenCalledTimes(1)
    expect(applied).toHaveBeenLastCalledWith('left', 74)
    expect(store.read('left')).toMatchObject({ lastTargetF: 74, lastAppliedAt: fixture.now(), application: { outcome: 'acknowledged' } })
    expect(store.history('left')[0]).toMatchObject({ kind: 'active' })
    expect(store.history('left')[0].preview).toBeUndefined()
    // Existing native v1 validation requires available=false; current conveys the new owner grant.
    expect(runtime.status('left').activation).toMatchObject({ available: false, current: true })
    await runtime.setMode('left', 'off')
    expect(owner.admission('left', store.read('left'))).toBeNull()
    expect(runtime.status('left').activation.available).toBe(false)
    expect(runtime.status('left').activation.current).toBe(false)
    await runtime.stop()
  }
  finally { fixture.database.close() }
})
