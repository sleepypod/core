/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@/src/db', () => {
  // Minimal drizzle-shaped stub. Each .select().from(...) is a thenable
  // that resolves to an empty row set on the next microtask. loadSchedules
  // thus produces no jobs but still yields to the event loop, which is what
  // the coalescing tests need.
  const makeQuery = () => {
    const promise: any = {
      async then(resolve: (v: any) => void) {
        await Promise.resolve()
        resolve([])
      },
      where() { return promise },
      limit() { return promise },
    }
    return promise
  }
  const fakeDb = {
    select() {
      return {
        from() {
          return makeQuery()
        },
      }
    },
    update() {
      return { set: () => ({ where: () => ({ run: () => undefined }) }) }
    },
    transaction: (fn: any) => fn({ update: fakeDb.update }),
  }
  return { db: fakeDb }
})

vi.mock('@/src/db/schema', () => {
  // Each "table" is just a tagged object so our fake .from() can distinguish them.
  // The stub DB doesn't actually query them, so the shape doesn't matter beyond the name.
  const make = (name: string) => ({ _: { name } })
  return {
    temperatureSchedules: make('temperatureSchedules'),
    powerSchedules: make('powerSchedules'),
    alarmSchedules: make('alarmSchedules'),
    deviceSettings: make('deviceSettings'),
    sideSettings: make('sideSettings'),
    runOnceSessions: make('runOnceSessions'),
    deviceState: make('deviceState'),
  }
})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({
    connect: vi.fn(async () => {}),
    setTemperature: vi.fn(async () => {}),
    setPower: vi.fn(async () => {}),
    setAlarm: vi.fn(async () => {}),
    startPriming: vi.fn(async () => {}),
  }),
}))

vi.mock('@/src/hardware/dacTransport', () => ({
  sendCommand: vi.fn(async () => {}),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: vi.fn(),
}))

vi.mock('@/src/services/autoOffWatcher', () => ({
  cancelAutoOffTimer: vi.fn(),
}))

import { JobManager } from '../jobManager'

/**
 * Count reload cycles by spying on Scheduler.cancelRecurringJobs, which is
 * called exactly once per reload cycle in runReloadCycle (and never by tests
 * directly). This is robust regardless of how many DB selects happen inside
 * each loadSchedules() pass.
 */
describe('JobManager.reloadSchedules coalescing', () => {
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC')
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  function spyReloadCount(): { count: () => number } {
    const scheduler = manager.getScheduler()
    let n = 0
    const orig = scheduler.cancelRecurringJobs.bind(scheduler)
    scheduler.cancelRecurringJobs = () => {
      n++
      orig()
    }
    return { count: () => n }
  }

  it('runs a follow-up reload when a second caller arrives while one is in flight', async () => {
    const { count } = spyReloadCount()

    const p1 = manager.reloadSchedules()
    const p2 = manager.reloadSchedules()

    await Promise.all([p1, p2])

    // 1 cycle for caller A, 1 follow-up cycle triggered by caller B's pending flag
    expect(count()).toBe(2)
  })

  it('collapses N concurrent callers into exactly 2 cycles', async () => {
    const { count } = spyReloadCount()

    const promises = [
      manager.reloadSchedules(),
      manager.reloadSchedules(),
      manager.reloadSchedules(),
      manager.reloadSchedules(),
      manager.reloadSchedules(),
    ]
    await Promise.all(promises)

    // Exactly 2: the initial cycle + one follow-up for all pending callers
    expect(count()).toBe(2)
  })

  it('a single caller runs exactly one cycle', async () => {
    const { count } = spyReloadCount()
    await manager.reloadSchedules()
    expect(count()).toBe(1)
  })

  it('sequential (non-overlapping) reloads each run a full cycle', async () => {
    const { count } = spyReloadCount()
    await manager.reloadSchedules()
    await manager.reloadSchedules()
    await manager.reloadSchedules()
    expect(count()).toBe(3)
  })

  it('pending-flag drains: late-arriving second caller is not dropped', async () => {
    const { count } = spyReloadCount()

    // Caller A starts and we let its first cycle begin
    const p1 = manager.reloadSchedules()
    // Before p1 resolves, caller B arrives. Its request should trigger a second cycle.
    const p2 = manager.reloadSchedules()

    await p1
    // After p1 resolves, the pending-flag-driven second cycle is also complete,
    // so count should be 2 by the time p1 returns to caller A.
    expect(count()).toBe(2)
    await p2
    expect(count()).toBe(2)
  })
})
