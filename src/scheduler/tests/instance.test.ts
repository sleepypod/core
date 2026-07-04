/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for src/scheduler/instance.ts — the JobManager singleton wrapper.
 *
 * Covers: lazy init, single-flight, timezone-from-db, default fallback on
 * db error, timezone caching across calls, shutdown teardown.
 *
 * The JobManager class is mocked at the import boundary so we exercise only
 * the wrapper's wiring — class behaviour is covered separately in
 * jobManager.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Module-scoped state we manipulate per test. Each test resets these via
// resetMocks() and then re-imports the instance module so its module-level
// `let` state (cachedTimezone, jobManagerInstance, jobManagerInitPromise) is
// fresh.
const loadSchedulesMock = vi.fn(async () => {})
const shutdownMock = vi.fn(async () => {})
const ctorMock = vi.fn()

vi.mock('../jobManager', () => {
  class JobManager {
    public timezone: string
    constructor(timezone: string) {
      this.timezone = timezone
      ctorMock(timezone)
    }

    loadSchedules = loadSchedulesMock
    shutdown = shutdownMock
  }
  return { JobManager }
})

// db.select().from(deviceSettings).limit(1) — drizzle-shaped thenable stub.
// `setDbBehavior` swaps in the next promise/rows the test wants returned.
let dbBehavior: () => Promise<any[]> = async () => []

vi.mock('@/src/db', () => {
  const makeQuery = (): any => {
    const promise: any = {
      async then(resolve: (v: any) => void, reject?: (e: unknown) => void) {
        try {
          const rows = await dbBehavior()
          resolve(rows)
        }
        catch (err) {
          if (reject) reject(err)
          else throw err
        }
      },
      where() { return promise },
      limit() { return promise },
    }
    return promise
  }
  return {
    db: {
      select() {
        return { from: () => makeQuery() }
      },
    },
  }
})

vi.mock('@/src/db/schema', () => ({
  deviceSettings: { _: { name: 'deviceSettings' } },
}))

import type * as InstanceModuleTypes from '../instance'
type InstanceModule = typeof InstanceModuleTypes

async function freshModule(): Promise<InstanceModule> {
  vi.resetModules()
  return await import('../instance')
}

describe('scheduler/instance', () => {
  beforeEach(() => {
    loadSchedulesMock.mockClear()
    shutdownMock.mockClear()
    ctorMock.mockClear()
    dbBehavior = async () => []
  })

  afterEach(async () => {
    // Best-effort cleanup so a leaked instance from one test can't bleed into
    // the next module-load. vi.resetModules() in freshModule() handles the
    // rest.
    const mod = await import('../instance')
    await mod.shutdownJobManager().catch(() => {})
  })

  it('falls back to America/Los_Angeles when device_settings row is missing', async () => {
    const mod = await freshModule()
    dbBehavior = async () => [] // no rows

    const m = await mod.getJobManager()

    expect(ctorMock).toHaveBeenCalledTimes(1)
    expect(ctorMock).toHaveBeenCalledWith('America/Los_Angeles')
    expect((m as any).timezone).toBe('America/Los_Angeles')
    expect(loadSchedulesMock).toHaveBeenCalledTimes(1)
  })

  it('uses the timezone stored in device_settings when present', async () => {
    const mod = await freshModule()
    dbBehavior = async () => [{ timezone: 'Europe/Berlin' }]

    await mod.getJobManager()

    expect(ctorMock).toHaveBeenCalledWith('Europe/Berlin')
  })

  it('falls back to default when the row has an empty timezone string', async () => {
    const mod = await freshModule()
    dbBehavior = async () => [{ timezone: '' }] // falsy

    await mod.getJobManager()

    expect(ctorMock).toHaveBeenCalledWith('America/Los_Angeles')
  })

  it('falls back to default and logs a warning when the db throws', async () => {
    const mod = await freshModule()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbBehavior = async () => {
      throw new Error('db down')
    }

    await mod.getJobManager()

    expect(ctorMock).toHaveBeenCalledWith('America/Los_Angeles')
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns the same instance on the second call (idempotent)', async () => {
    const mod = await freshModule()
    dbBehavior = async () => [{ timezone: 'UTC' }]

    const a = await mod.getJobManager()
    const b = await mod.getJobManager()

    expect(a).toBe(b)
    expect(ctorMock).toHaveBeenCalledTimes(1)
    expect(loadSchedulesMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent callers into a single initialization (single-flight)', async () => {
    const mod = await freshModule()
    let resolveLoad: () => void = () => {}
    const loadStarted = new Promise<void>((startResolve) => {
      loadSchedulesMock.mockImplementationOnce(
        () => new Promise<void>((resolve) => {
          resolveLoad = () => resolve()
          startResolve()
        }),
      )
    })
    dbBehavior = async () => [{ timezone: 'UTC' }]

    const p1 = mod.getJobManager()
    const p2 = mod.getJobManager()
    const p3 = mod.getJobManager()

    // Wait until loadSchedules has actually been entered before unblocking it,
    // so the second and third callers latch onto jobManagerInitPromise rather
    // than racing past it.
    await loadStarted
    resolveLoad()

    const [a, b, c] = await Promise.all([p1, p2, p3])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(ctorMock).toHaveBeenCalledTimes(1)
    expect(loadSchedulesMock).toHaveBeenCalledTimes(1)
  })

  it('retries timezone load after a failed first attempt (no instance cached)', async () => {
    const mod = await freshModule()
    // First load throws AFTER timezone is read — so jobManagerInstance is
    // never assigned, but cachedTimezone may have been set. We simulate this
    // path by having loadSchedules() reject the first time.
    dbBehavior = async () => [{ timezone: 'UTC' }]
    loadSchedulesMock.mockRejectedValueOnce(new Error('boom'))

    await expect(mod.getJobManager()).rejects.toThrow('boom')

    // After failure, the init promise is cleared (the finally block) and the
    // next call starts a fresh attempt. Both attempts hit the ctor since the
    // instance never settled.
    loadSchedulesMock.mockResolvedValueOnce(undefined)
    const m = await mod.getJobManager()
    expect(m).toBeTruthy()
    expect(ctorMock).toHaveBeenCalledTimes(2)
    expect(loadSchedulesMock).toHaveBeenCalledTimes(2)
  })

  it('shuts down a partially-initialized manager when loadSchedules throws', async () => {
    const mod = await freshModule()
    dbBehavior = async () => [{ timezone: 'UTC' }]
    // loadSchedules can fail after registering some jobs; the discarded
    // manager's node-schedule timers would keep firing and a retry would
    // register duplicates → double hardware commands.
    loadSchedulesMock.mockRejectedValueOnce(new Error('partial init'))

    await expect(mod.getJobManager()).rejects.toThrow('partial init')
    expect(shutdownMock).toHaveBeenCalledTimes(1)
  })

  it('still surfaces the loadSchedules error when cleanup shutdown also fails', async () => {
    const mod = await freshModule()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbBehavior = async () => [{ timezone: 'UTC' }]
    loadSchedulesMock.mockRejectedValueOnce(new Error('partial init'))
    shutdownMock.mockRejectedValueOnce(new Error('shutdown also broken'))

    await expect(mod.getJobManager()).rejects.toThrow('partial init')
    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to clean up partially-initialized JobManager:',
      'shutdown also broken',
    )
    warnSpy.mockRestore()
  })

  it('caches the resolved timezone across retries (single db read)', async () => {
    const mod = await freshModule()
    let dbCalls = 0
    dbBehavior = async () => {
      dbCalls++
      return [{ timezone: 'Asia/Tokyo' }]
    }
    loadSchedulesMock.mockRejectedValueOnce(new Error('boom'))

    await expect(mod.getJobManager()).rejects.toThrow('boom')

    loadSchedulesMock.mockResolvedValueOnce(undefined)
    await mod.getJobManager()

    expect(dbCalls).toBe(1) // cachedTimezone short-circuits the second read
    expect(ctorMock).toHaveBeenNthCalledWith(2, 'Asia/Tokyo')
  })

  it('shutdownJobManager tears down the instance and clears state', async () => {
    const mod = await freshModule()
    dbBehavior = async () => [{ timezone: 'UTC' }]

    const before = await mod.getJobManager()
    await mod.shutdownJobManager()

    expect(shutdownMock).toHaveBeenCalledTimes(1)

    // After shutdown, a fresh getJobManager() constructs a new instance and
    // reloads timezone from db (cachedTimezone reset).
    let dbReads = 0
    dbBehavior = async () => {
      dbReads++
      return [{ timezone: 'Europe/Paris' }]
    }
    const after = await mod.getJobManager()

    expect(after).not.toBe(before)
    expect(ctorMock).toHaveBeenCalledTimes(2)
    expect(dbReads).toBe(1)
    expect(ctorMock).toHaveBeenNthCalledWith(2, 'Europe/Paris')
  })

  it('shutdownJobManager is a no-op when no instance exists', async () => {
    const mod = await freshModule()
    await mod.shutdownJobManager()
    expect(shutdownMock).not.toHaveBeenCalled()
  })
})
