import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExperimentApplicationAdapter } from '../application'
import { applicationFixture } from './applicationFixture'
import { EXPERIMENT_LEASE_MS } from '../application-contract'
import { DEVICE_MAX_AGE_MS, PRESENCE_MAX_AGE_MS } from '../../policy'

const fixtures: ReturnType<typeof applicationFixture>[] = []
function fixture() {
  const value = applicationFixture()
  fixtures.push(value)
  return value
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.database.close()
  vi.restoreAllMocks()
})

describe('scheduled experiment execution through the real temperature authority', () => {
  it('journals the winning treatment and retains the real producer identifier and schedule countdown', async () => {
    const test = fixture()
    await test.adapter.reconcile('left')
    expect(test.writes).toEqual([{ side: 'left', targetF: 69, part: 'level' }, { side: 'left', targetF: 69, part: 'duration' }])
    expect(test.journal.latest('left')).toMatchObject({ outcome: 'acknowledged', reservation: { requestId: test.selectedId, previousF: 70, targetF: 69 } })
    expect(test.authority.status('left')).toMatchObject({ requestId: test.selectedId, targetTemperature: 69 })
    expect(test.journal.latest('right')).toBeNull()
    const count = test.writes.length
    test.advance(5000)
    await test.adapter.reconcile('left')
    expect(test.writes).toHaveLength(count)
    expect(test.controllerDeps.readHardwareDeadline('left')).toBe(test.window.routineEnd)
  })

  it.each(['not_enabled', 'no_admission', 'adaptation_running', 'pause', 'empty', 'water', 'priming', 'vibration', 'base', 'stale_device', 'stale_presence', 'future_device', 'ambiguous', 'wake_changed', 'power_off', 'wrong_side', 'stopped'])(
    'does not submit a treatment when %s', async (reason) => {
      const test = fixture(), sample = test.samples.left
      if (reason === 'not_enabled') test.settings.enabled = false
      if (reason === 'no_admission') test.settings.admission = null
      if (reason === 'adaptation_running') test.settings.adaptationSuspended = false
      if (reason === 'pause') test.settings.manualPausedUntil = test.now() + 60_000
      if (reason === 'empty') sample.occupied = false
      if (reason === 'water') sample.waterAdequate = false
      if (reason === 'priming') sample.priming = true
      if (reason === 'vibration') sample.vibrating = true
      if (reason === 'base') sample.baseMoving = null
      if (reason === 'stale_device') sample.deviceAt = test.now() - DEVICE_MAX_AGE_MS - 1
      if (reason === 'stale_presence') sample.presenceAt = test.now() - PRESENCE_MAX_AGE_MS - 1
      if (reason === 'future_device') sample.deviceAt = test.now() + 1
      if (reason === 'ambiguous') sample.attributionAmbiguous = true
      if (reason === 'wake_changed') sample.wakeHash = 'f'.repeat(64)
      if (reason === 'power_off') sample.powered = false
      if (reason === 'wrong_side') test.admission.sides = ['right']
      if (reason === 'stopped') test.plans.stop(test.plan.id, test.record().revision)
      await test.adapter.reconcile('left')
      expect(test.writes).toEqual([])
      expect(test.journal.latest('left')).toBeNull()
    },
  )

  it('stops at the reviewed wake boundary and leaves the effective wake owner in charge', async () => {
    const test = fixture()
    await test.adapter.reconcile('left')
    test.advance(test.window.windowEnd - test.now())
    test.baselines.left = [{ ...test.baselines.left[0], id: 'wake', source: 'run-once', temperature: 105,
      startsAt: test.now(), expiresAt: test.window.routineEnd }]
    await test.adapter.reconcile('left')
    expect(test.authority.status('left')).toMatchObject({ requestId: 'wake', targetTemperature: 105 })
    expect(test.writes.slice(-2).map(value => value.targetF)).toEqual([105, 105])
    expect(test.journal.latest('left')?.reservation.targetF).toBe(69)
  })

  it('never restores an old target over a later manual adjustment or powers an off side', async () => {
    const test = fixture()
    await test.adapter.reconcile('left')
    await test.authority.setManual('left', 71)
    test.plans.stop(test.plan.id, test.record().revision)
    const count = test.writes.length
    await test.adapter.reconcile('left')
    expect(test.writes).toHaveLength(count)
    expect(test.authority.status('left')).toMatchObject({ source: 'manual', targetTemperature: 71 })
    test.samples.left.powered = false
    await test.adapter.reconcile('left')
    expect(test.samples.left.powered).toBe(false)
    expect(test.writes).toHaveLength(count)
  })

  it.each(['stop', 'water', 'revoke', 'clock', 'monotonic', 'grant', 'foreign_intent'])(
    'rechecks %s at the actual hardware write after waiting in the queue', async (reason) => {
      const test = fixture()
      test.beforeApply(async () => {
        if (reason === 'stop') test.plans.stop(test.plan.id, test.record().revision)
        if (reason === 'water') test.samples.left.waterAdequate = false
        if (reason === 'revoke') test.adapter.revoke('left')
        if (reason === 'clock') test.advance(EXPERIMENT_LEASE_MS)
        if (reason === 'monotonic') test.monotonic(EXPERIMENT_LEASE_MS + 1000)
        if (reason === 'grant') test.admission.revision = randomUUID()
        if (reason === 'foreign_intent') {
          const current = test.journal.latest('left')
          if (!current) throw new Error('The fixture intent is missing')
          current.reservation.id = randomUUID()
          test.database.prepare('UPDATE comfort_experiment_applications SET id = ?, record = ? WHERE side = ?')
            .run(current.reservation.id, JSON.stringify(current), 'left')
        }
      })
      await expect(test.adapter.reconcile('left')).rejects.toThrow('Current control conditions')
      expect(test.writes).toEqual([])
      expect(test.journal.latest('left')?.outcome).not.toBe('acknowledged')
    },
  )

  it('retains an uncertain partial write and blocks retry even in a fresh adapter', async () => {
    const test = fixture()
    test.betweenWrites(() => {
      test.samples.left.waterAdequate = false
    })
    await expect(test.adapter.reconcile('left')).rejects.toThrow()
    expect(test.writes).toEqual([{ side: 'left', targetF: 69, part: 'level' }])
    expect(test.journal.latest('left')?.outcome).toBe('unknown')
    test.samples.left.waterAdequate = true
    await new ExperimentApplicationAdapter(test.deps).reconcile('left')
    expect(test.writes).toHaveLength(1)
  })

  it('withdraws a corrupt snapshot without allowing a new treatment', async () => {
    const test = fixture()
    await test.adapter.reconcile('left')
    test.database.prepare('UPDATE comfort_experiments SET record = ? WHERE id = ?').run('{broken', test.plan.id)
    await test.adapter.reconcile('left')
    expect(test.authority.status('left').source).toBe('schedule')
    expect(test.writes.at(-1)?.targetF).toBe(70)
  })

  it('waits for actual reported target confirmation and withdraws contradictory fresh reports', async () => {
    const test = fixture()
    test.reportTarget(false)
    await test.adapter.reconcile('left')
    expect(test.authority.status('left').requestId).toBe(test.selectedId)
    test.advance(2000)
    expect(test.samples.left.targetF).toBe(70)
    await test.adapter.reconcile('left')
    expect(test.authority.status('left').source).toBe('schedule')
    test.samples.left.targetF = 69
    await test.adapter.reconcile('left')
    expect(test.authority.status('left').source).toBe('schedule')
  })

  it('does not latch one side failure onto an independently controlled other side', async () => {
    const test = fixture()
    test.samples.left.targetF = 71
    await test.adapter.reconcile('left')
    await test.adapter.reconcile('right')
    expect(test.writes.every(write => write.side === 'right' && write.targetF === 69)).toBe(true)
    expect(test.journal.latest('right')?.outcome).toBe('acknowledged')
  })

  it('never records an application when another rule wins arbitration', async () => {
    const test = fixture()
    await test.authority.replaceAutopilot('left', [{ ...test.baselines.left[0], id: 'higher-priority-rule', source: 'autopilot', temperature: 70 }])
    const count = test.writes.length
    await test.adapter.reconcile('left')
    expect(test.authority.status('left').requestId).toBe('higher-priority-rule')
    expect(test.writes).toHaveLength(count)
    expect(test.journal.latest('left')).toBeNull()
  })

  it('rechecks changed conditions after transport reconnect without submitting the experiment', async () => {
    const test = fixture()
    test.controllerDeps.connect = async () => {
      test.settings.adaptationSuspended = false
    }
    await test.adapter.reconcile('left')
    expect(test.writes.some(value => value.targetF === 69)).toBe(false)
    expect(test.journal.latest('left')).toBeNull()
  })

  it('withholds a missing attribution decision rather than treating undefined as unambiguous', async () => {
    const test = fixture(), read = test.deps.read
    test.deps.read = (side, now) => {
      const snapshot = read(side, now)
      if (snapshot) Object.assign(snapshot.sample, { attributionAmbiguous: undefined })
      return snapshot
    }
    await test.adapter.reconcile('left')
    expect(test.writes).toEqual([])
  })

  it('retains an unresolved reservation when finishing storage fails, without replaying', async () => {
    const test = fixture()
    test.deps.finish = () => {
      throw new Error('disk unavailable')
    }
    await expect(test.adapter.reconcile('left')).rejects.toThrow('disk unavailable')
    expect(test.journal.latest('left')?.outcome).toBe('attempting')
    await new ExperimentApplicationAdapter(test.deps).reconcile('left')
    expect(test.writes).toHaveLength(2)
  })
})
