import { afterEach, expect, it } from 'vitest'
import { comfortEvent } from '../../store'
import { ExperimentExecutionHost } from '../execution'
import { executionFixture } from './executionFixture'

const fixtures: Awaited<ReturnType<typeof executionFixture>>[] = []
async function fixture() {
  const test = await executionFixture()
  fixtures.push(test)
  return test
}
afterEach(async () => {
  for (const test of fixtures.splice(0)) {
    await test.host.stop()
    test.database.close()
  }
})

it('requires reviewed admission, then applies through the real authority and hands off to the preserved wake plan', async () => {
  const test = await fixture()
  expect(test.writes).not.toHaveBeenCalled()
  const grant = await test.admit()
  expect(test.writes).not.toHaveBeenCalled()
  const window = test.plan.schedule.windows[0]
  test.advance(window.windowStart + 1)
  await test.host.tick()
  expect(test.writes).toHaveBeenCalledExactlyOnceWith('left', 74)
  expect(test.host.admissions.current('left')?.grant.review.id).toBe(grant.review.id)
  test.baselines.push({ id: 'actual-wake', source: 'run-once', temperature: 105,
    startsAt: window.windowEnd, expiresAt: window.routineEnd, createdAt: window.windowEnd, priority: 0 })
  test.advance(window.windowEnd)
  await test.host.tick()
  expect(test.writes).toHaveBeenLastCalledWith('left', 105)
})

it.each(['account', 'routine', 'manual', 'pending_pause', 'adaptation'] as const)(
  'permanently withdraws an admitted experiment after %s changes', async (change) => {
    const test = await fixture(), grant = await test.admit(), window = test.plan.schedule.windows[0]
    test.advance(window.windowStart + 1)
    await test.host.tick()
    if (change === 'account') test.admitted(false)
    if (change === 'routine') test.database.prepare('UPDATE power_schedules SET on_temperature = 76').run()
    if (change === 'manual') {
      const state = test.store.read('left')
      test.store.commit('left', { ...state, pausedUntil: test.now() + 6 * 3_600_000 }, comfortEvent(test.now(), 'manual_pause', 'Synthetic manual control'))
    }
    if (change === 'pending_pause') test.pendingPause(test.now())
    if (change === 'adaptation') test.configure({ config: { ...test.store.read('left').config, mode: 'active' } })
    await test.host.tick()
    test.admitted(true)
    test.pendingPause(null)
    test.database.prepare('UPDATE power_schedules SET on_temperature = 75').run()
    expect(test.host.admissions.current('left')).toBeNull()
    expect(test.host.admissions.claim('left')).toBeNull()
    const saved = test.database.prepare('SELECT revoked_at FROM comfort_experiment_admissions WHERE id = ?').get(grant.review.id) as { revoked_at: number }
    expect(saved.revoked_at).toBe(test.now())
  },
)

it('revalidates the actual source history after service restart before publishing any lease', async () => {
  const test = await fixture(), grant = await test.admit()
  await test.host.stop()
  test.database.prepare('DELETE FROM comfort_events WHERE report_id = ?').run(grant.review.zones[0].evidence.nights[0].summary.id)
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  const restarted = new ExperimentExecutionHost(test.deps)
  try {
    await restarted.start()
    expect(test.writes).not.toHaveBeenCalled()
    expect(restarted.admissions.current('left')).toBeNull()
  }
  finally { await restarted.stop() }
})

it('periodically rechecks source records during a running comparison', async () => {
  const test = await fixture(), grant = await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  test.database.prepare('DELETE FROM comfort_events WHERE report_id = ?').run(grant.review.zones[0].evidence.nights[0].summary.id)
  test.advance(test.now() + 60_000)
  await test.host.tick()
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.writes).toHaveBeenLastCalledWith('left', 75)
})

it('releases its admission when the existing planning Stop action stops the saved experiment', async () => {
  const test = await fixture()
  await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  const current = test.plans.read(test.plan.id)
  if (!current) throw new Error('Synthetic plan missing')
  test.plans.stop(test.plan.id, current.revision)
  await test.host.tick()
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.writes).toHaveBeenLastCalledWith('left', 75)
})

it('cancels an admitted comparison without restoring an older target over a new independent plan', async () => {
  const test = await fixture(), grant = await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  await test.host.tick()
  test.baselines[0] = { ...test.baselines[0], temperature: 76 }
  await test.host.cancel(test.principal, grant.review.id, () => {})
  await test.host.tick()
  expect(test.writes).toHaveBeenLastCalledWith('left', 76)
  expect(test.store.read('left').config.mode).toBe('preview')
  expect(test.host.admissions.claim('left')).toBeNull()
})

it('drains a queued application on shutdown without replaying it', async () => {
  const test = await fixture()
  await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>((resolve) => {
    entered = resolve
  })
  test.beforeApply(async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  const pending = test.host.tick()
  await arrived
  const stopped = test.host.stop()
  release()
  await Promise.all([pending, stopped])
  expect(test.writes).not.toHaveBeenCalled()
  expect(test.host.isRunning()).toBe(false)
})

it('withdraws both solo zones before the second dispatch when the first application becomes uncertain', async () => {
  const test = await fixture()
  await test.qualifyRight()
  await test.admit()
  test.advance(test.plan.schedule.windows[0].windowStart + 1)
  test.beforeApply(async () => {
    throw new Error('Synthetic firmware uncertainty')
  })
  await test.host.tick()
  expect(test.writes).not.toHaveBeenCalled()
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.host.admissions.claim('right')).toBeNull()
  expect(test.database.prepare('SELECT side, outcome FROM comfort_experiment_applications').all())
    .toEqual([{ side: 'left', outcome: 'unknown' }])
})

it('rechecks the authenticated account after cancellation waits for an existing side operation', async () => {
  const test = await fixture(), grant = await test.admit()
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>((resolve) => {
    entered = resolve
  })
  const held = test.deps.withSideLock('left', async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await arrived
  const pending = test.host.cancel(test.principal, grant.review.id, () => {})
  const rejected = expect(pending).rejects.toThrow('Device revoked')
  test.admitted(false)
  release()
  await held
  await rejected
  test.admitted(true)
  expect(test.host.admissions.claim('left')?.revokedAt).toBeNull()
})

it('cancels every originally admitted zone after the current physical assignment becomes unavailable', async () => {
  const test = await fixture()
  await test.qualifyRight()
  const grant = await test.admit()
  test.deps.resolve = () => {
    throw new Error('Assignment unavailable')
  }
  let release!: () => void, entered!: () => void, waiting!: () => void
  const arrived = new Promise<void>((resolve) => {
    entered = resolve
  })
  const queued = new Promise<void>((resolve) => {
    waiting = resolve
  })
  const originalLock = test.deps.withSideLock
  const held = originalLock('right', async () => {
    entered()
    await new Promise<void>((resolve) => {
      release = resolve
    })
  })
  await arrived
  test.deps.withSideLock = (side, work) => {
    if (side === 'right') waiting()
    return originalLock(side, work)
  }
  const pending = test.host.cancel(test.principal, grant.review.id, () => {})
  await queued
  expect(test.host.admissions.claim('right')?.revokedAt).toBeNull()
  release()
  await Promise.all([held, pending])
  expect(test.host.admissions.claim('left')).toBeNull()
  expect(test.host.admissions.claim('right')).toBeNull()
  expect(test.writes).not.toHaveBeenCalled()
})
