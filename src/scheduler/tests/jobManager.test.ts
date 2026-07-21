/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const hardwareClient = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  setTemperature: vi.fn(async () => {}),
  setPower: vi.fn(async () => {}),
  setAlarm: vi.fn(async () => {}),
  startPriming: vi.fn(async () => {}),
  sendRaw: vi.fn<(command: string, arg?: string) => Promise<string>>(),
}))
const pumpStallMock = vi.hoisted(() => ({
  shouldBlock: vi.fn<(side: 'left' | 'right') => boolean>(() => false),
}))
const writeFileMock = vi.hoisted(() => vi.fn<(path: string, data: string) => Promise<void>>(async () => {}))
const renameMock = vi.hoisted(() => vi.fn<(from: string, to: string) => Promise<void>>(async () => {}))
const execMock = vi.hoisted(() => vi.fn())

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

vi.mock('@/src/hardware/dacTransport', () => ({
  sendCommand: vi.fn(async () => ''),
  connectDac: vi.fn(async () => {}),
  isDacConnected: vi.fn(() => true),
}))

vi.mock('@/src/hardware/dacMonitor.instance', async () => {
  const { sendCommand } = await import('@/src/hardware/dacTransport')
  hardwareClient.sendRaw.mockImplementation(async (command: string, arg?: string) => sendCommand(command, arg))
  return {
    getSharedHardwareClient: () => hardwareClient,
  }
})

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: vi.fn(),
}))

vi.mock('@/src/hardware/pumpStallGuard', () => pumpStallMock)

vi.mock('@/src/services/autoOffWatcher', () => ({
  cancelAutoOffTimer: vi.fn(),
}))

vi.mock('node:fs/promises', () => ({
  writeFile: writeFileMock,
  rename: renameMock,
}))

vi.mock('child_process', () => ({ exec: execMock }))

import { decode as cborDecode } from 'cbor-x'
import { db } from '@/src/db'
import { sendCommand } from '@/src/hardware/dacTransport'
import { fahrenheitToLevel, HardwareCommand } from '@/src/hardware/types'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { JobManager } from '../jobManager'
import { JobType } from '../types'

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

// ─────────────────────────────────────────────────────────────────────────────
// Misc public-surface tests that don't need a real DB. The stub mock above
// returns empty rows from every select, so DB-driven branches can't be hit
// here — but the in-memory scheduler-side surface (getScheduler, run-once
// scheduling, cancellation, heartbeat lifecycle) can.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager public surface (stub DB)', () => {
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    vi.useRealTimers()
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  it('getScheduler exposes the underlying Scheduler', () => {
    const sched = manager.getScheduler()
    expect(sched).toBeDefined()
    expect(typeof sched.scheduleJob).toBe('function')
    expect(sched.getTimezone()).toBe('UTC')
    expect(sched.isEnabled()).toBe(true)
  })

  it('logs exact job execution and error event messages', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const scheduler = manager.getScheduler()
    const failure = new Error('event failure')

    scheduler.emit('jobExecuted', 'job-ok', { success: true, timestamp: new Date(0) })
    scheduler.emit('jobExecuted', 'job-failed', {
      success: false,
      error: 'hardware failed',
      timestamp: new Date(0),
    })
    scheduler.emit('jobError', 'job-error', failure)

    expect(log).toHaveBeenCalledWith('Job executed successfully: job-ok')
    expect(error).toHaveBeenCalledWith('Job execution failed: job-failed', 'hardware failed')
    expect(error).toHaveBeenCalledWith('Job error: job-error', failure)
  })

  it('re-registers lifecycle listeners without leaving duplicates behind', () => {
    const scheduler = manager.getScheduler()

    ;(manager as any).setupEventListeners()
    ;(manager as any).setupEventListeners()

    expect(scheduler.listenerCount('jobScheduled')).toBe(1)
    expect(scheduler.listenerCount('jobExecuted')).toBe(1)
    expect(scheduler.listenerCount('jobError')).toBe(1)
  })

  it('logs exact aggregate messages while loading an empty schedule set', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await manager.loadSchedules()

    expect(log).toHaveBeenCalledWith('Loading schedules from database...')
    expect(log).toHaveBeenCalledWith('Loaded 0 scheduled jobs')
  })

  it('does not schedule away transitions at the exact current instant', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const now = new Date().toISOString()

    manager.upsertAwayMode('left', now, now)

    expect(manager.getScheduler().getJob('away-start-left')).toBeUndefined()
    expect(manager.getScheduler().getJob('away-return-left')).toBeUndefined()
    vi.useRealTimers()
  })

  it('scheduleRunOnceSession adds setpoint + cleanup jobs', () => {
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const setPointTime = fmt(new Date(now.getTime() + 5 * 60_000))
    const wakeTime = fmt(new Date(now.getTime() + 60 * 60_000))

    manager.scheduleRunOnceSession(123, 'left', [{ time: setPointTime, temperature: 80 }], wakeTime, 'UTC')

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('runonce-123-0')
    expect(ids).toContain('runonce-cleanup-123')
  })

  it('rescheduling a session with a filtered set-point list leaves no stale jobs', () => {
    // Regression (review 4.13): restoreRunOnceSessions passes a FILTERED
    // list whose indices shift; a surviving runonce-S-2 plus a re-indexed
    // runonce-S-0 could fire the same set point twice.
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const t1 = fmt(new Date(now.getTime() + 5 * 60_000))
    const t2 = fmt(new Date(now.getTime() + 10 * 60_000))
    const t3 = fmt(new Date(now.getTime() + 15 * 60_000))
    const wakeTime = fmt(new Date(now.getTime() + 60 * 60_000))

    manager.scheduleRunOnceSession(7, 'left', [
      { time: t1, temperature: 78 },
      { time: t2, temperature: 76 },
      { time: t3, temperature: 74 },
    ], wakeTime, 'UTC')
    expect(manager.getScheduler().getJobs()).toHaveLength(4) // 3 points + cleanup

    // In-process reschedule with the first point filtered out (already fired)
    manager.scheduleRunOnceSession(7, 'left', [
      { time: t2, temperature: 76 },
      { time: t3, temperature: 74 },
    ], wakeTime, 'UTC')

    const jobs = manager.getScheduler().getJobs()
    expect(jobs).toHaveLength(3) // 2 points + cleanup, no leftovers
    const temps = jobs
      .filter(j => j.id.startsWith('runonce-7-'))
      .map(j => j.metadata?.targetTemperature)
      .sort()
    expect(temps).toEqual([74, 76]) // each set point scheduled exactly once
  })

  it('rescheduling one run-once session preserves every unrelated job', () => {
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const setPointTime = fmt(new Date(now.getTime() + 10 * 60_000))
    const wakeTime = fmt(new Date(now.getTime() + 60 * 60_000))

    manager.scheduleRunOnceSession(1, 'left', [{ time: setPointTime, temperature: 78 }], wakeTime, 'UTC')
    manager.scheduleRunOnceSession(2, 'right', [{ time: setPointTime, temperature: 80 }], wakeTime, 'UTC')
    manager.scheduleRunOnceSession(1, 'left', [{ time: setPointTime, temperature: 76 }], wakeTime, 'UTC')

    expect(manager.getScheduler().getJob('runonce-2-0')).toBeDefined()
    expect(manager.getScheduler().getJob('runonce-cleanup-2')).toBeDefined()
  })

  it('cancelRunOnceSession removes only run-once jobs scoped to the side', () => {
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const setPointTime = fmt(new Date(now.getTime() + 5 * 60_000))
    const wakeTime = fmt(new Date(now.getTime() + 60 * 60_000))

    manager.scheduleRunOnceSession(1, 'left', [{ time: setPointTime, temperature: 80 }], wakeTime, 'UTC')
    manager.scheduleRunOnceSession(2, 'right', [{ time: setPointTime, temperature: 80 }], wakeTime, 'UTC')

    expect(manager.getScheduler().getJobs()).toHaveLength(4)

    manager.cancelRunOnceSession('right')

    const remaining = manager.getScheduler().getJobs()
    expect(remaining.every(j => j.metadata?.side !== 'right')).toBe(true)
    expect(remaining.filter(j => j.metadata?.side === 'left')).toHaveLength(2)
  })

  it('cancelRunOnceSession preserves a same-side recurring job', () => {
    const scheduler = manager.getScheduler()
    scheduler.scheduleJob(
      'left-recurring-temperature',
      JobType.TEMPERATURE,
      '0 8 * * *',
      async () => {},
      { side: 'left' },
    )

    manager.cancelRunOnceSession('left')

    expect(scheduler.getJob('left-recurring-temperature')).toBeDefined()
  })

  it('startHeartbeat / stopHeartbeat are idempotent', () => {
    manager.startHeartbeat()
    manager.startHeartbeat() // second call no-ops
    manager.stopHeartbeat()
    manager.stopHeartbeat() // double-stop is safe
  })

  it('stopHeartbeat clears its timer and permits a fresh timer to start', () => {
    const interval = vi.spyOn(globalThis, 'setInterval')
    const clear = vi.spyOn(globalThis, 'clearInterval')

    manager.startHeartbeat()
    manager.stopHeartbeat()
    manager.startHeartbeat()

    expect(interval).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledOnce()
  })

  it('startHeartbeat does not create a second interval on re-entry (kills L258 guard mutant)', () => {
    // Kills `if (this.heartbeatTimer) return` → `if (false) return`. Without
    // the guard, every call would leak a new setInterval and the cleanup in
    // stopHeartbeat would only clear the latest, leaving prior intervals to
    // fire forever.
    const setIntervalSpy = vi.spyOn(global, 'setInterval')
    manager.startHeartbeat()
    const callsAfterFirst = setIntervalSpy.mock.calls.length
    manager.startHeartbeat()
    manager.startHeartbeat()
    expect(setIntervalSpy.mock.calls.length).toBe(callsAfterFirst)
    setIntervalSpy.mockRestore()
  })

  it('checkLiveness returns empty when no jobs are registered', async () => {
    const stale = await manager.checkLiveness()
    expect(stale).toEqual([])
  })

  it('shutdown can be called repeatedly without error', async () => {
    await manager.shutdown()
    await manager.shutdown()
    // afterEach will call once more
  })

  it('shutdown stops the heartbeat, removes listeners, and delegates to Scheduler', async () => {
    const scheduler = manager.getScheduler()
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const shutdown = vi.spyOn(scheduler, 'shutdown').mockResolvedValue()
    manager.startHeartbeat()

    await manager.shutdown()

    expect(clear).toHaveBeenCalledOnce()
    expect(scheduler.listenerCount('jobScheduled')).toBe(0)
    expect(scheduler.listenerCount('jobExecuted')).toBe(0)
    expect(scheduler.listenerCount('jobError')).toBe(0)
    expect(shutdown).toHaveBeenCalledOnce()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat liveness — pins the staleness arithmetic, RUN_ONCE skip, null
// nextInvocation skip, and the reload-cooldown branch so a node-schedule
// freeze (no fires, no exception) still triggers a recovery reload.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager.checkLiveness', () => {
  const STALE_MS = 90_000
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: STALE_MS,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  // ScheduledJob shape stripped to what checkLiveness reads (id + type).
  const fakeJob = (id: string, type: JobType): any => ({ id, type, schedule: '', job: {} })

  function stubScheduler(jobs: Array<{ id: string, type: JobType }>, nextAt: (id: string) => Date | null) {
    const scheduler = manager.getScheduler()
    vi.spyOn(scheduler, 'getJobs').mockReturnValue(jobs.map(j => fakeJob(j.id, j.type)))
    vi.spyOn(scheduler, 'getNextInvocation').mockImplementation((id: string) => nextAt(id))
  }

  it('returns empty list and does not reload when all jobs fire in the future', async () => {
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => new Date(Date.now() + 60_000),
    )

    expect(await manager.checkLiveness()).toEqual([])
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('does NOT mark future jobs stale — arithmetic is `now - staleMs`, not `now + staleMs`', async () => {
    // Kills `now - staleMs` → `now + staleMs` mutator: under the mutation a job
    // ~30s in the future would satisfy `nextMs < now + 90_000` and reload-spam.
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => new Date(Date.now() + 30_000),
    )

    expect(await manager.checkLiveness()).toEqual([])
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('does NOT mark a job at exactly the staleness boundary — comparison is strict `<`', async () => {
    // Kills `<` → `<=`: at nextMs === now - staleMs, strict `<` is false.
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => new Date(fixedNow - STALE_MS),
    )

    expect(await manager.checkLiveness()).toEqual([])
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('marks a recurring job overdue past the stale window and forces a reload', async () => {
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => new Date(Date.now() - STALE_MS - 5_000),
    )

    expect(await manager.checkLiveness()).toEqual(['temp-1'])
    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('skips RUN_ONCE jobs even when their next invocation is overdue', async () => {
    // Kills mutating the RUN_ONCE guard to a no-op or its conditional to true/false:
    // a one-shot whose Date has passed must NOT be force-reloaded — node-schedule
    // already retires it after firing.
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'runonce-1-0', type: JobType.RUN_ONCE }],
      () => new Date(Date.now() - STALE_MS - 5_000),
    )

    expect(await manager.checkLiveness()).toEqual([])
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('ignores jobs whose getNextInvocation returns null', async () => {
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => null,
    )

    expect(await manager.checkLiveness()).toEqual([])
    expect(reloadSpy).not.toHaveBeenCalled()
  })

  it('suppresses follow-up reloads while the cooldown window is open', async () => {
    // Kills `cooldownLeft > 0` → `false` and removing the cooldown branch:
    // a persistent freeze should NOT spin reload on every tick.
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => new Date(Date.now() - STALE_MS - 5_000),
    )

    await manager.checkLiveness() // first detection — reloads
    await manager.checkLiveness() // still inside 5-min cooldown
    await manager.checkLiveness()

    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('returns the stale id list even when suppressed by cooldown', async () => {
    // The function returns `stale` from the cooldown branch (line 296), not [].
    // Mutating that return to `[]` would break health endpoints that read the list.
    vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-1', type: JobType.TEMPERATURE }],
      () => new Date(Date.now() - STALE_MS - 5_000),
    )

    await manager.checkLiveness() // first call sets cooldown
    expect(await manager.checkLiveness()).toEqual(['temp-1'])
  })

  it('uses a strict cooldown boundary and reloads when exactly 300 seconds elapsed', async () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    const reload = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    stubScheduler(
      [{ id: 'temp-boundary', type: JobType.TEMPERATURE }],
      () => new Date(fixedNow - STALE_MS - 1),
    )
    ;(manager as any).lastHeartbeatReloadAt = fixedNow - 300_000

    expect(await manager.checkLiveness()).toEqual(['temp-boundary'])
    expect(reload).toHaveBeenCalledOnce()
  })

  it('logs the exact cooldown warning with only the first three stale ids', async () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const jobs = ['temp-a', 'temp-b', 'temp-c', 'temp-d']
      .map(id => ({ id, type: JobType.TEMPERATURE }))
    stubScheduler(jobs, () => new Date(fixedNow - STALE_MS - 1))
    ;(manager as any).lastHeartbeatReloadAt = fixedNow - 175_000

    expect(await manager.checkLiveness()).toEqual(['temp-a', 'temp-b', 'temp-c', 'temp-d'])
    expect(warn).toHaveBeenCalledWith(
      '[scheduler] 4 jobs overdue past nextRun by >90000ms '
      + '(examples: temp-a, temp-b, temp-c). Reload cooldown active for 125s.',
    )
  })

  it('logs the exact forced-reload warning and exact reload error', async () => {
    const fixedNow = 1_700_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow)
    vi.spyOn(manager, 'reloadSchedules').mockRejectedValue(new Error('reload boom'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const jobs = ['temp-a', 'temp-b', 'temp-c', 'temp-d']
      .map(id => ({ id, type: JobType.TEMPERATURE }))
    stubScheduler(jobs, () => new Date(fixedNow - STALE_MS - 1))

    expect(await manager.checkLiveness()).toEqual(['temp-a', 'temp-b', 'temp-c', 'temp-d'])
    expect(warn).toHaveBeenCalledWith(
      '[scheduler] 4 jobs overdue past nextRun by >90000ms '
      + '(examples: temp-a, temp-b, temp-c). Forcing reloadSchedules().',
    )
    expect(error).toHaveBeenCalledWith(
      '[scheduler] heartbeat-triggered reload failed:',
      'reload boom',
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LED night-mode window — pins the initial-brightness decision when
// scheduleLedNightMode runs at load time. The window math is delicate:
// arithmetic on nowHour/startHour/endHour with non-zero minutes, strict <=
// vs < boundary on start/end, and the same-day vs midnight-crossing branch.
// Each test below was picked to kill a specific mutator class — see the
// inline comments. Drives the private method directly via cast because
// loadSchedules requires DB rows the stub doesn't provide.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager.scheduleLedNightMode initial brightness', () => {
  let manager: JobManager

  beforeEach(() => {
    vi.useFakeTimers()
    manager = new JobManager('UTC')
  })

  afterEach(async () => {
    vi.useRealTimers()
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  function run(nowIso: string): {
    sendLed: ReturnType<typeof vi.fn>
    scheduleJob: ReturnType<typeof vi.fn>
  } {
    vi.setSystemTime(new Date(nowIso))
    const sendLed = vi.fn(async () => {})
    ;(manager as any).sendLedBrightness = sendLed
    const scheduleJob = vi.fn(() => ({} as any))
    vi.spyOn(manager.getScheduler(), 'scheduleJob').mockImplementation(scheduleJob as any)
    return { sendLed, scheduleJob }
  }

  // Same-day window: current time inside, with non-zero minutes on now —
  // kills nowHour * 60 + nowMinute → nowHour * 60 - nowMinute (gives a
  // smaller in-window number that still tests TRUE here) only when end is
  // close to now. So we tighten the window: 22:05-23:05, now=22:30. With
  // the mutation nowMinutes=22*60-30=1290 < startMinutes=1325 → DAY.
  it('night brightness applied when current minute pushes us inside a tight same-day window (kills + → - on nowMinutes)', async () => {
    const { sendLed } = run('2026-01-15T22:30:00Z')
    await (manager as any).scheduleLedNightMode('22:05', '23:05', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
  })

  // Same-day window: current is JUST before start, so a smaller mutated
  // start (22*60-10=1310) would flip it to inside the window → kills the
  // + → - mutation on startMinutes (and / 60).
  it('day brightness when current is just before start — kills + → - on startMinutes', async () => {
    const { sendLed } = run('2026-01-15T22:05:00Z')
    await (manager as any).scheduleLedNightMode('22:10', '23:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(80)
  })

  // Same-day window with a non-zero end minute, observed from inside.
  it('night brightness when current is just inside the end of a tight window', async () => {
    const { sendLed } = run('2026-01-15T22:15:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '22:30', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
  })

  // The mutated end (22*60-30=1290) makes this look like a cross-midnight
  // window, incorrectly keeping 22:45 in night mode.
  it('day brightness after a same-day window with a non-zero end minute', async () => {
    const { sendLed } = run('2026-01-15T22:45:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '22:30', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(80)
  })

  // start === end: with the real `<=` we take the same-day branch which
  // can never be true (start..start is empty) → DAY. Mutating `<=` to `<`
  // takes the midnight branch (>= start || < end), which is always true →
  // would flip to NIGHT. Kills `startMinutes <= endMinutes` mutators.
  it('day brightness when start === end (degenerate window) — kills <= → < on the branch selector', async () => {
    const { sendLed } = run('2026-01-15T03:00:00Z')
    await (manager as any).scheduleLedNightMode('01:00', '01:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(80)
  })

  // Midnight-crossing window. Current in the "after midnight" portion
  // (03:00 within 22:00-06:00). Mutating `||` → `&&` in the cross-midnight
  // branch flips it to DAY because the >= startMinutes leg is false.
  it('night when current is in the post-midnight portion of a cross-midnight window — kills || → &&', async () => {
    const { sendLed } = run('2026-01-15T03:00:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
  })

  // Midnight-crossing window. Current in the "before midnight" portion
  // (23:00 within 22:00-06:00). Mutating `||` → `&&` flips to DAY because
  // the < endMinutes leg is false.
  it('night when current is in the pre-midnight portion of a cross-midnight window — kills || → &&', async () => {
    const { sendLed } = run('2026-01-15T23:00:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
  })

  it('includes the exact start minute of a cross-midnight window', async () => {
    const { sendLed } = run('2026-01-15T22:00:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
  })

  it('excludes the exact end minute of a cross-midnight window', async () => {
    const { sendLed } = run('2026-01-15T06:00:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(80)
  })

  // Same-day window with current well outside. Mutating `&&` → `||` would
  // flip this to NIGHT because >= startMinutes alone is true.
  it('day when current is past the same-day window — kills && → ||', async () => {
    const { sendLed } = run('2026-01-15T08:00:00Z')
    await (manager as any).scheduleLedNightMode('01:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(80)
  })

  // Start boundary inclusive: current === start → NIGHT. Mutating
  // `nowMinutes >= startMinutes` to `> startMinutes` (or `< startMinutes`)
  // would flip to DAY.
  it('night at the exact start minute — kills >= → > on the start boundary', async () => {
    const { sendLed } = run('2026-01-15T01:00:00Z')
    await (manager as any).scheduleLedNightMode('01:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
  })

  // End boundary exclusive: current === end → DAY. Mutating
  // `nowMinutes < endMinutes` to `<= endMinutes` (or `>= endMinutes`)
  // would flip to NIGHT.
  it('day at the exact end minute — kills < → <= on the end boundary', async () => {
    const { sendLed } = run('2026-01-15T06:00:00Z')
    await (manager as any).scheduleLedNightMode('01:00', '06:00', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(80)
  })

  // Cron strings registered for the two recurring jobs. Kills the
  // `${minute} ${hour} * * *` template StringLiteral mutators on lines 517
  // and 525, plus the scheduleJob BlockStatement mutators.
  it('registers led-night-start and led-night-end with correct cron expressions', async () => {
    const { scheduleJob } = run('2026-01-15T12:00:00Z')
    await (manager as any).scheduleLedNightMode('22:05', '06:45', 80, 10)

    expect(scheduleJob).toHaveBeenCalledWith(
      'led-night-start',
      JobType.LED_BRIGHTNESS,
      '5 22 * * *',
      expect.any(Function),
      { brightness: 10 },
    )
    expect(scheduleJob).toHaveBeenCalledWith(
      'led-night-end',
      JobType.LED_BRIGHTNESS,
      '45 6 * * *',
      expect.any(Function),
      { brightness: 80 },
    )
  })

  // Pin that the registered callbacks actually call sendLedBrightness
  // with the correct per-job brightness. Kills BlockStatement mutators on
  // the two scheduleJob arrow bodies (lines 519-522, 527-530).
  it('scheduled callbacks send the correct brightness for night vs day', async () => {
    const { sendLed, scheduleJob } = run('2026-01-15T12:00:00Z')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await (manager as any).scheduleLedNightMode('22:00', '06:00', 80, 10)

    // Clear the initial-apply call; we want to inspect what the cron
    // handlers do when fired manually.
    sendLed.mockClear()

    const calls = scheduleJob.mock.calls as Array<[string, JobType, string, () => Promise<void>]>
    const startCb = calls.find(c => c[0] === 'led-night-start')?.[3]
    const endCb = calls.find(c => c[0] === 'led-night-end')?.[3]
    if (!startCb || !endCb) throw new Error('expected both led-night-* callbacks registered')

    await startCb()
    expect(sendLed).toHaveBeenLastCalledWith(10) // night → night brightness
    expect(log).toHaveBeenCalledWith('LED night mode: setting brightness to 10')

    await endCb()
    expect(sendLed).toHaveBeenLastCalledWith(80) // morning → day brightness
    expect(log).toHaveBeenCalledWith('LED night mode: setting brightness to 80')
  })

  it('logs the exact initial-brightness failure and keeps both jobs scheduled', async () => {
    const { sendLed, scheduleJob } = run('2026-01-15T12:00:00Z')
    const failure = new Error('DAC offline')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sendLed.mockRejectedValueOnce(failure)

    await expect(
      (manager as any).scheduleLedNightMode('22:00', '06:00', 80, 10),
    ).resolves.toBeUndefined()

    expect(scheduleJob).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      'LED night mode: failed to apply initial brightness:',
      failure,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Incremental upsert / cancel — the API that route handlers call instead of
// reloadSchedules(). Pins:
//   1. Idempotency: upserting the same row twice leaves exactly one job.
//   2. No-wipe: mutating one row's job doesn't touch any other row's job.
//   3. Disabled rows act as cancel: upsertX({enabled:false, ...}) removes the
//      existing job rather than scheduling a disabled-but-armed timer.
//   4. yggdrasil-49 regression: an unrelated upsert at HH:MM:04 (inside an
//      alarm's fire window) does NOT cancel-and-recreate the alarm job, so
//      its `nextInvocation` is not bumped 7 days into the future.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager incremental upsert/cancel', () => {
  let manager: JobManager

  // Use a far-future date so weekly cron jobs registered in these tests sit
  // safely in the next-invocation window and won't accidentally fire.
  const baseTemp = {
    id: 1,
    side: 'left' as const,
    dayOfWeek: 'monday' as const,
    time: '22:00',
    temperature: 68,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
  const basePower = {
    id: 1,
    side: 'left' as const,
    dayOfWeek: 'monday' as const,
    onTime: '22:00',
    offTime: '07:00',
    onTemperature: 75,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
  const baseAlarm = {
    id: 1,
    side: 'left' as const,
    dayOfWeek: 'monday' as const,
    time: '07:00',
    vibrationIntensity: 50,
    vibrationPattern: 'rise' as const,
    duration: 120,
    alarmTemperature: 80,
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }

  beforeEach(() => {
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('upsertTemperatureJob is idempotent: two calls with the same row leave one job', () => {
    manager.upsertTemperatureJob(baseTemp)
    manager.upsertTemperatureJob(baseTemp)
    const jobs = manager.getScheduler().getJobs().filter(j => j.id === `temp-${baseTemp.id}`)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].type).toBe(JobType.TEMPERATURE)
  })

  it('registers exact metadata for temperature, power, and alarm jobs', () => {
    manager.upsertTemperatureJob(baseTemp)
    manager.upsertPowerJob(basePower)
    manager.upsertAlarmJob(baseAlarm)
    const scheduler = manager.getScheduler()

    expect(scheduler.getJob('temp-1')?.metadata).toEqual({
      scheduleId: 1,
      side: 'left',
      targetTemperature: 68,
    })
    expect(scheduler.getJob('power-on-1')?.metadata).toEqual({
      scheduleId: 1,
      side: 'left',
      targetTemperature: 75,
    })
    expect(scheduler.getJob('power-off-1')?.metadata).toEqual({
      scheduleId: 1,
      side: 'left',
    })
    expect(scheduler.getJob('alarm-1')?.metadata).toEqual({
      scheduleId: 1,
      side: 'left',
      targetTemperature: 80,
    })
  })

  it('registers exact daily prime and reboot cron expressions', () => {
    ;(manager as any).scheduleDailyPriming('14:05')
    ;(manager as any).scheduleDailyReboot('03:07')

    expect(manager.getScheduler().getJob('daily-prime')?.schedule).toBe('5 14 * * *')
    expect(manager.getScheduler().getJob('daily-reboot')?.schedule).toBe('7 3 * * *')
  })

  it('upsertPowerJob schedules both on+off, cancelPowerJob removes both', () => {
    manager.upsertPowerJob(basePower)
    const sched = manager.getScheduler()
    expect(sched.getJob(`power-on-${basePower.id}`)).toBeDefined()
    expect(sched.getJob(`power-off-${basePower.id}`)).toBeDefined()

    manager.cancelPowerJob(basePower.id)
    expect(sched.getJob(`power-on-${basePower.id}`)).toBeUndefined()
    expect(sched.getJob(`power-off-${basePower.id}`)).toBeUndefined()
  })

  it('upsertAlarmJob with enabled=false acts as cancel', () => {
    manager.upsertAlarmJob(baseAlarm)
    expect(manager.getScheduler().getJob(`alarm-${baseAlarm.id}`)).toBeDefined()

    manager.upsertAlarmJob({ ...baseAlarm, enabled: false })
    expect(manager.getScheduler().getJob(`alarm-${baseAlarm.id}`)).toBeUndefined()
  })

  it('upsertTemperatureJob with enabled=false acts as cancel', () => {
    manager.upsertTemperatureJob(baseTemp)
    expect(manager.getScheduler().getJob(`temp-${baseTemp.id}`)).toBeDefined()

    manager.upsertTemperatureJob({ ...baseTemp, enabled: false })
    expect(manager.getScheduler().getJob(`temp-${baseTemp.id}`)).toBeUndefined()
  })

  it('upsertPowerJob with enabled=false acts as cancel of both on+off', () => {
    manager.upsertPowerJob(basePower)
    expect(manager.getScheduler().getJob(`power-on-${basePower.id}`)).toBeDefined()
    expect(manager.getScheduler().getJob(`power-off-${basePower.id}`)).toBeDefined()

    manager.upsertPowerJob({ ...basePower, enabled: false })
    expect(manager.getScheduler().getJob(`power-on-${basePower.id}`)).toBeUndefined()
    expect(manager.getScheduler().getJob(`power-off-${basePower.id}`)).toBeUndefined()
  })

  it('cancelX is a no-op when the job is absent', () => {
    expect(() => manager.cancelTemperatureJob(999)).not.toThrow()
    expect(() => manager.cancelPowerJob(999)).not.toThrow()
    expect(() => manager.cancelAlarmJob(999)).not.toThrow()
  })

  it('no-wipe: upserting one alarm leaves an unrelated temperature job untouched', () => {
    manager.upsertTemperatureJob(baseTemp)
    const tempJobBefore = manager.getScheduler().getJob(`temp-${baseTemp.id}`)
    expect(tempJobBefore).toBeDefined()
    const nextBefore = manager.getScheduler().getNextInvocation(`temp-${baseTemp.id}`)?.getTime()

    // Upsert an unrelated alarm — the temperature job's identity and next-fire
    // time must not move. reloadSchedules() would have cancelled+recreated it.
    manager.upsertAlarmJob(baseAlarm)
    const tempJobAfter = manager.getScheduler().getJob(`temp-${baseTemp.id}`)
    expect(tempJobAfter).toBe(tempJobBefore) // same object identity → not recreated
    expect(manager.getScheduler().getNextInvocation(`temp-${baseTemp.id}`)?.getTime()).toBe(nextBefore)
  })

  it('yggdrasil-49 regression: upserting an unrelated row inside an alarm fire-window does not bump the alarm', () => {
    // Schedule the alarm and remember its next invocation.
    manager.upsertAlarmJob(baseAlarm)
    const alarmJobBefore = manager.getScheduler().getJob(`alarm-${baseAlarm.id}`)
    expect(alarmJobBefore).toBeDefined()
    const nextBefore = manager.getScheduler().getNextInvocation(`alarm-${baseAlarm.id}`)?.getTime()
    expect(nextBefore).toBeDefined()

    // Simulate the mutation landing 4s past the cron minute. With the old
    // reloadSchedules() this would cancel-and-recreate every recurring job;
    // the alarm whose `time` already passed today would skip to next week.
    manager.upsertTemperatureJob({ ...baseTemp, id: 99, temperature: 70 })

    // The alarm's underlying job is the same instance and its nextInvocation
    // hasn't moved. Net effect: the alarm still fires this week.
    const alarmJobAfter = manager.getScheduler().getJob(`alarm-${baseAlarm.id}`)
    expect(alarmJobAfter).toBe(alarmJobBefore)
    expect(manager.getScheduler().getNextInvocation(`alarm-${baseAlarm.id}`)?.getTime()).toBe(nextBefore)
  })

  it('alarm CRUD via incremental helpers completes well under the 200ms unit-test budget', () => {
    const start = performance.now()
    for (let i = 0; i < 50; i++) {
      manager.upsertAlarmJob({ ...baseAlarm, id: i, time: '07:00' })
    }
    for (let i = 0; i < 50; i++) {
      manager.cancelAlarmJob(i)
    }
    const elapsed = performance.now() - start
    // 100 ops well under 200ms — incremental work is O(1) per call, no DB scan.
    expect(elapsed).toBeLessThan(200)
  })

  it('upsertRebootJob with rebootDaily=false cancels any existing daily-reboot job', () => {
    manager.upsertRebootJob(true, '03:00')
    expect(manager.getScheduler().getJob('daily-reboot')).toBeDefined()
    manager.upsertRebootJob(false, '03:00')
    expect(manager.getScheduler().getJob('daily-reboot')).toBeUndefined()
  })

  it('upsertPrimeJob (re)schedules all three prime-related jobs together', () => {
    manager.upsertPrimeJob(true, '14:00')
    const sched = manager.getScheduler()
    expect(sched.getJob('daily-prime')).toBeDefined()
    expect(sched.getJob('prime-prereboot')).toBeDefined()
    expect(sched.getJob('pre-prime-calibration')).toBeDefined()

    manager.cancelPrimeJob()
    expect(sched.getJob('daily-prime')).toBeUndefined()
    expect(sched.getJob('prime-prereboot')).toBeUndefined()
    expect(sched.getJob('pre-prime-calibration')).toBeUndefined()
  })

  it('upsertPrimeJob with primePodDaily=false cancels any existing prime jobs', () => {
    manager.upsertPrimeJob(true, '14:00')
    manager.upsertPrimeJob(false, '14:00')
    const sched = manager.getScheduler()
    expect(sched.getJob('daily-prime')).toBeUndefined()
    expect(sched.getJob('prime-prereboot')).toBeUndefined()
    expect(sched.getJob('pre-prime-calibration')).toBeUndefined()
  })

  it('upsertLedNightMode applies day brightness immediately when disabled (200ms LED budget)', async () => {
    const sendLed = vi.fn(async () => {})
    ;(manager as any).sendLedBrightness = sendLed

    // First enable so jobs exist.
    await manager.upsertLedNightMode(true, '22:00', '06:00', 80, 10)
    expect(manager.getScheduler().getJob('led-night-start')).toBeDefined()

    // Now disable — jobs cancelled, day brightness restored on the hardware.
    sendLed.mockClear()
    const start = performance.now()
    await manager.upsertLedNightMode(false, '22:00', '06:00', 80, 10)
    const elapsed = performance.now() - start
    expect(manager.getScheduler().getJob('led-night-start')).toBeUndefined()
    expect(manager.getScheduler().getJob('led-night-end')).toBeUndefined()
    expect(sendLed).toHaveBeenCalledWith(80)
    expect(elapsed).toBeLessThan(200)
  })

  it('upsertLedNightMode swallows sendLedBrightness failure on disable so the route still succeeds', async () => {
    const sendLed = vi.fn(async () => {
      throw new Error('DAC not connected')
    })
    ;(manager as any).sendLedBrightness = sendLed
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      manager.upsertLedNightMode(false, '22:00', '06:00', 80, 10)
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('LED night mode'),
      expect.any(Error),
    )
    warn.mockRestore()
  })

  it('upsertLedNightMode with enabled=true but null times is a no-op (cancel without day-brightness restore)', async () => {
    const sendLed = vi.fn(async () => {})
    ;(manager as any).sendLedBrightness = sendLed

    await manager.upsertLedNightMode(true, '22:00', '06:00', 80, 10)
    sendLed.mockClear()

    // enabled=true so the `if (!enabled)` restore branch must NOT fire — but the
    // outer guard still cancels the cron jobs because times are null.
    await manager.upsertLedNightMode(true, null, '06:00', 80, 10)
    expect(manager.getScheduler().getJob('led-night-start')).toBeUndefined()
    expect(manager.getScheduler().getJob('led-night-end')).toBeUndefined()
    expect(sendLed).not.toHaveBeenCalled()
  })

  it('upsertAwayMode schedules away-start and away-return when values are non-null', () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const later = new Date(Date.now() + 8 * 86_400_000).toISOString()
    manager.upsertAwayMode('left', future, later)
    expect(manager.getScheduler().getJob('away-start-left')).toBeDefined()
    expect(manager.getScheduler().getJob('away-return-left')).toBeDefined()
  })

  it.each([
    ['start only', 'left', 7, null, 'away-start-left'],
    ['return only', 'right', null, 8, 'away-return-right'],
  ] as const)('upsertAwayMode schedules a %s window', (_label, side, startDays, returnDays, expectedId) => {
    const date = (days: number | null) => days == null
      ? null
      : new Date(Date.now() + days * 86_400_000).toISOString()

    manager.upsertAwayMode(side, date(startDays), date(returnDays))

    expect(manager.getScheduler().getJob(expectedId)).toBeDefined()
  })

  it('upsertAwayMode cancels existing jobs when both inputs are null', () => {
    const future = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const later = new Date(Date.now() + 8 * 86_400_000).toISOString()
    manager.upsertAwayMode('left', future, later)
    manager.upsertAwayMode('left', null, null)
    expect(manager.getScheduler().getJob('away-start-left')).toBeUndefined()
    expect(manager.getScheduler().getJob('away-return-left')).toBeUndefined()
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// sendLedBrightness CBOR wire format. Frank's SetSettings (cmd 8) silently
// ignores unknown keys — so the test pins the exact key ("lb") and value the
// firmware actually consumes. Belt-and-suspenders: the key-bytes regex (`626c62`)
// pins the wire key name independent of cbor-x's map-header encoding; the
// decode round-trip is the authoritative structural check.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager.sendLedBrightness CBOR payload', () => {
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC')
    ;(sendCommand as ReturnType<typeof vi.fn>).mockClear()
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('encodes {lb: N} under SET_SETTINGS — not the legacy ledBrightness key', async () => {
    await (manager as any).sendLedBrightness(42)

    expect(sendCommand).toHaveBeenCalledTimes(1)
    const [cmd, hex] = (sendCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [HardwareCommand, string]
    expect(cmd).toBe(HardwareCommand.SET_SETTINGS)

    // Wire format check: the key bytes for "lb" (text2 → 62 6c 62) must be
    // present. The value byte is verified by the decode round-trip below;
    // pinning it with an anchored regex would falsely fail if cbor-x ever
    // emitted an indefinite-length map terminator (`ff`).
    expect(hex).toMatch(/626c62/)

    // Decode round-trip — authoritative source of truth.
    const decoded = cborDecode(Buffer.from(hex, 'hex'))
    expect(decoded).toEqual({ lb: 42 })
    expect(decoded).not.toHaveProperty('ledBrightness')
  })

  it('encodes 0 (full-dim) without ambiguity', async () => {
    await (manager as any).sendLedBrightness(0)
    const [, hex] = (sendCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [HardwareCommand, string]
    const decoded = cborDecode(Buffer.from(hex, 'hex'))
    expect(decoded).toEqual({ lb: 0 })
  })

  it('encodes 100 (full-bright) as a single-byte uint', async () => {
    await (manager as any).sendLedBrightness(100)
    const [, hex] = (sendCommand as ReturnType<typeof vi.fn>).mock.calls[0] as [HardwareCommand, string]
    const decoded = cborDecode(Buffer.from(hex, 'hex'))
    expect(decoded).toEqual({ lb: 100 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeCurrentLedBrightness — the in-window math is exercised exhaustively
// via scheduleLedNightMode tests above. These cover the branches that path
// doesn't reach: night mode disabled, null start/end (corrupted DB row).
// applyCurrentLedBrightness has its own short check that exits cleanly when
// the device_settings row is missing.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager.computeCurrentLedBrightness — out-of-window branches', () => {
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC')
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('returns day brightness when night mode is disabled', () => {
    const result = (manager as any).computeCurrentLedBrightness(false, '22:00', '06:00', 80, 10)
    expect(result).toBe(80)
  })

  it('returns day brightness when night start time is null (mis-seeded row)', () => {
    const result = (manager as any).computeCurrentLedBrightness(true, null, '06:00', 80, 10)
    expect(result).toBe(80)
  })

  it('returns day brightness when night end time is null', () => {
    const result = (manager as any).computeCurrentLedBrightness(true, '22:00', null, 80, 10)
    expect(result).toBe(80)
  })
})

describe('JobManager.applyCurrentLedBrightness', () => {
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC')
    ;(sendCommand as ReturnType<typeof vi.fn>).mockClear()
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('is a no-op when device_settings is empty (fresh install)', async () => {
    await manager.applyCurrentLedBrightness()
    expect(sendCommand).not.toHaveBeenCalled()
  })

  it('sends day brightness CBOR when night mode is disabled', async () => {
    vi.spyOn(db, 'select').mockReturnValueOnce({
      from: () => ({
        limit: async () => [{
          ledNightModeEnabled: false,
          ledNightStartTime: '22:00',
          ledNightEndTime: '06:00',
          ledDayBrightness: 75,
          ledNightBrightness: 10,
        }],
      }),
    } as any)
    await manager.applyCurrentLedBrightness()
    expect(sendCommand).toHaveBeenCalledWith(HardwareCommand.SET_SETTINGS, expect.any(String))
    const [, hex] = (sendCommand as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(cborDecode(Buffer.from(hex, 'hex'))).toEqual({ lb: 75 })
  })
})

describe('JobManager.loadSchedules YIELD_EVERY yielding', () => {
  let manager: JobManager

  beforeEach(() => {
    manager = new JobManager('UTC')
  })

  afterEach(async () => {
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  it('awaits setImmediate every 25 entries so the event loop can service I/O', async () => {
    // 30 rows per kind exceeds YIELD_EVERY=25, so each of the three loops
    // (temperature, power, alarm) must take the yield branch at least once.
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, enabled: false }))
    vi.spyOn(db, 'select').mockImplementation((() => ({
      from: () => {
        const q: any = {
          where: () => q,
          limit: () => Promise.resolve([]),
          then: (resolve: (v: any) => void) => resolve(rows),
        }
        return q
      },
    })) as any)

    const setImmediateSpy = vi.spyOn(global, 'setImmediate') as unknown as ReturnType<typeof vi.fn>
    await manager.loadSchedules()
    // Three loops, each yielding at i=24 (1-indexed 25). The system schedules
    // call also runs but uses .limit, not the looped path.
    expect(setImmediateSpy).toHaveBeenCalledTimes(3)
  })
})

describe('JobManager residual mutation contracts', () => {
  let manager: JobManager

  const row = {
    enabled: true,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }

  function queryRows(rows: unknown[]): any {
    const query: any = Promise.resolve(rows)
    query.where = () => query
    query.limit = () => query
    return query
  }

  function required<T>(value: T | undefined, label: string): T {
    if (value === undefined) throw new Error(`Missing captured ${label}`)
    return value
  }

  function mockSelectRows(...results: unknown[][]): ReturnType<typeof vi.spyOn> {
    const select = vi.spyOn(db, 'select') as any
    for (const rows of results) {
      select.mockReturnValueOnce({ from: () => queryRows(rows) })
    }
    return select
  }

  function captureOneTimeJobs(): Map<string, { handler: () => Promise<void>, metadata: unknown }> {
    const captured = new Map<string, { handler: () => Promise<void>, metadata: unknown }>()
    vi.spyOn(manager.getScheduler(), 'scheduleOneTimeJob').mockImplementation((
      id,
      type,
      fireDate,
      handler,
      metadata,
    ) => {
      captured.set(id, { handler, metadata })
      return {
        id,
        type,
        schedule: fireDate.toISOString(),
        job: { cancel: vi.fn() },
        metadata,
      } as any
    })
    return captured
  }

  beforeEach(() => {
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
    for (const mock of Object.values(hardwareClient)) mock.mockClear()
    hardwareClient.connect.mockResolvedValue(undefined)
    hardwareClient.setTemperature.mockResolvedValue(undefined)
    hardwareClient.setPower.mockResolvedValue(undefined)
    vi.mocked(broadcastMutationStatus).mockClear()
    pumpStallMock.shouldBlock.mockReset().mockReturnValue(false)
    writeFileMock.mockClear()
    renameMock.mockClear()
    execMock.mockReset()
  })

  afterEach(async () => {
    delete process.env.CALIBRATION_TRIGGER_PATH
    vi.useRealTimers()
    await manager.shutdown()
    vi.restoreAllMocks()
  })

  it('logs every recurring-job skip and the alarm vibration-only branch exactly', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(manager, 'hasActiveRunOnceSession')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false)

    await manager.runTemperatureJob({
      ...row,
      id: 11,
      side: 'left',
      dayOfWeek: 'monday',
      time: '08:00',
      temperature: 78,
    })
    await manager.runPowerOnJob({
      ...row,
      id: 12,
      side: 'right',
      dayOfWeek: 'monday',
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
    })
    await manager.runPowerOffJob({
      ...row,
      id: 13,
      side: 'left',
      dayOfWeek: 'monday',
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
    })
    await manager.runTemperatureJob({
      ...row,
      id: 14,
      side: 'right',
      dayOfWeek: 'monday',
      time: '08:00',
      temperature: 76,
    })
    await manager.runAlarmJob({
      ...row,
      id: 15,
      side: 'right',
      dayOfWeek: 'monday',
      time: '06:30',
      alarmTemperature: 88,
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 30,
    })

    expect(log).toHaveBeenCalledWith(
      'Skipping recurring temp job temp-11 — run-once session active for left',
    )
    expect(log).toHaveBeenCalledWith(
      'Skipping recurring power-on job — run-once session active for right',
    )
    expect(log).toHaveBeenCalledWith(
      'Skipping recurring power-off job — run-once session active for left',
    )
    expect(log).toHaveBeenCalledWith('Skipping temp job temp-14 — right is not powered')
    expect(log).toHaveBeenCalledWith(
      'Alarm job alarm-15 — right not powered; skipping temperature, firing vibration only',
    )
  })

  it('skips energizing temp and power-on jobs while the pump stall guard blocks the side', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(manager, 'hasActiveRunOnceSession').mockResolvedValue(false)
    vi.spyOn(manager as any, 'isSidePowered').mockResolvedValue(true)
    pumpStallMock.shouldBlock.mockReturnValue(true)

    await manager.runTemperatureJob({
      ...row,
      id: 41,
      side: 'left',
      dayOfWeek: 'monday',
      time: '08:00',
      temperature: 78,
    })
    await manager.runPowerOnJob({
      ...row,
      id: 42,
      side: 'right',
      dayOfWeek: 'monday',
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
    })

    expect(hardwareClient.setTemperature).not.toHaveBeenCalled()
    expect(hardwareClient.setPower).not.toHaveBeenCalled()
    expect(broadcastMutationStatus).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[jobManager] skipped temp job temp-41: pump stall guard blocks left')
    expect(warn).toHaveBeenCalledWith('[jobManager] skipped power-on power-on-42: pump stall guard blocks right')
  })

  it('fires alarm vibration but skips its temperature while the guard blocks the side', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(manager as any, 'isSidePowered').mockResolvedValue(true)
    pumpStallMock.shouldBlock.mockReturnValue(true)

    await manager.runAlarmJob({
      ...row,
      id: 43,
      side: 'right',
      dayOfWeek: 'monday',
      time: '06:30',
      alarmTemperature: 88,
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 30,
    })

    expect(hardwareClient.setTemperature).not.toHaveBeenCalled()
    expect(hardwareClient.setAlarm).toHaveBeenCalledWith('right', {
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 30,
    })
    expect(warn).toHaveBeenCalledWith(
      '[jobManager] skipped alarm temperature alarm-43: pump stall guard blocks right; firing vibration only',
    )
    expect(broadcastMutationStatus).toHaveBeenCalledWith('right', { isAlarmVibrating: true })
  })

  it('skips away-return power-on while the guard blocks the side but still clears awayMode', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()
    const updates: Array<Record<string, unknown>> = []
    vi.spyOn(db, 'transaction').mockImplementation(((callback: any) => callback({
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values)
          return { where: () => ({ run: vi.fn() }) }
        },
      }),
    })) as any)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pumpStallMock.shouldBlock.mockReturnValue(true)

    ;(manager as any).scheduleAwayMode('left', null, new Date(Date.now() + 60_000).toISOString())
    await required(captured.get('away-return-left'), 'away-return-left').handler()

    expect(updates[0]).toMatchObject({ awayMode: false })
    expect(hardwareClient.setPower).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[jobManager] skipped away-return power-on: pump stall guard blocks left')
  })

  it('skips a run-once set point while the guard blocks the side', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    pumpStallMock.shouldBlock.mockReturnValue(true)

    manager.scheduleRunOnceSession(78, 'left', [{ time: '12:10', temperature: 78 }], '13:00', 'UTC')
    await required(captured.get('runonce-78-0'), 'runonce-78-0').handler()

    expect(hardwareClient.setTemperature).not.toHaveBeenCalled()
    expect(broadcastMutationStatus).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith('[jobManager] skipped run-once set point: pump stall guard blocks left')
  })

  it('pins away-mode state writes, payloads, metadata, logs, and failure warnings', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()
    const updates: Array<Record<string, unknown>> = []
    vi.spyOn(db, 'transaction').mockImplementation(((callback: any) => callback({
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values)
          return { where: () => ({ run: vi.fn() }) }
        },
      }),
    })) as any)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const futureStart = new Date(Date.now() + 60_000).toISOString()
    const futureReturn = new Date(Date.now() + 120_000).toISOString()

    ;(manager as any).scheduleAwayMode('left', futureStart, futureReturn)

    expect(captured.get('away-start-left')?.metadata).toEqual({ side: 'left' })
    expect(captured.get('away-return-left')?.metadata).toEqual({ side: 'left' })
    await required(captured.get('away-start-left'), 'away-start-left').handler()
    expect(updates[0]).toMatchObject({ awayMode: true })
    expect(log).toHaveBeenCalledWith('Away mode: activating for left')
    expect(hardwareClient.setPower).toHaveBeenCalledWith('left', false)
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })

    await required(captured.get('away-return-left'), 'away-return-left').handler()
    expect(updates[1]).toMatchObject({ awayMode: false })
    expect(log).toHaveBeenCalledWith('Away mode: deactivating for left')
    expect(hardwareClient.setPower).toHaveBeenCalledWith('left', true)

    const startFailure = new Error('off failed')
    hardwareClient.setPower.mockRejectedValueOnce(startFailure)
    await required(captured.get('away-start-left'), 'away-start-left').handler()
    expect(warn).toHaveBeenCalledWith('[awayMode] Failed to power off left:', startFailure)

    const returnFailure = new Error('on failed')
    hardwareClient.setPower.mockRejectedValueOnce(returnFailure)
    await required(captured.get('away-return-left'), 'away-return-left').handler()
    expect(warn).toHaveBeenCalledWith('[awayMode] Failed to power on left:', returnFailure)
  })

  it('pins reboot, pre-prime, and calibration handler effects and exact logs', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-20T12:34:56.789Z')
    vi.setSystemTime(now)
    const handlers = new Map<string, () => Promise<void>>()
    vi.spyOn(manager.getScheduler(), 'scheduleJob').mockImplementation((
      id,
      type,
      schedule,
      handler,
      metadata,
    ) => {
      handlers.set(id, handler)
      return { id, type, schedule, handler, metadata, job: { cancel: vi.fn() } } as any
    })
    const reboot = vi.spyOn(manager as any, 'executeReboot').mockResolvedValue(undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    ;(manager as any).scheduleDailyReboot('03:00')
    ;(manager as any).schedulePrimePreReboot('14:00')
    ;(manager as any).schedulePrePrimeCalibration('14:00')
    await required(handlers.get('daily-reboot'), 'daily-reboot')()
    await required(handlers.get('prime-prereboot'), 'prime-prereboot')()
    await required(handlers.get('pre-prime-calibration'), 'pre-prime-calibration')()

    expect(reboot).toHaveBeenCalledTimes(2)
    expect(log).toHaveBeenCalledWith('Executing daily system reboot...')
    expect(log).toHaveBeenCalledWith('Executing pre-prime system reboot...')
    expect(log).toHaveBeenCalledWith('Triggering pre-prime sensor calibration...')
    expect(log).toHaveBeenCalledWith(
      'Calibration trigger written — calibrator module will process within 10s',
    )
    const [tmpPath, payload] = writeFileMock.mock.calls[0]
    const target = `/persistent/sleepypod-data/.calibrate-trigger.${now.getTime()}`
    expect(tmpPath).toBe(`${target}.tmp`)
    expect(renameMock).toHaveBeenCalledWith(`${target}.tmp`, target)
    expect(JSON.parse(payload as string)).toEqual({
      side: 'all',
      sensor_type: 'all',
      ts: Math.floor(now.getTime() / 1000),
    })

    reboot.mockRestore()
    const failure = new Error('permission denied')
    execMock.mockImplementationOnce((_command: string, callback: (error: Error) => void) => callback(failure))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect((manager as any).executeReboot()).rejects.toBe(failure)
    expect(error).toHaveBeenCalledWith('Reboot command failed:', 'permission denied')
  })

  it('pins run-once setpoint payloads and cleanup metadata', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()

    manager.scheduleRunOnceSession(
      77,
      'left',
      [{ time: '12:10', temperature: 78 }],
      '13:00',
      'UTC',
    )

    expect(captured.get('runonce-cleanup-77')?.metadata).toEqual({
      sessionId: 77,
      side: 'left',
      cleanup: true,
    })
    await required(captured.get('runonce-77-0'), 'runonce-77-0').handler()
    expect(hardwareClient.setTemperature).toHaveBeenCalledWith('left', 78)
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', {
      targetTemperature: 78,
      targetLevel: fahrenheitToLevel(78),
    })
  })

  it('logs exact cancelled and missing cleanup statuses without powering off', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()
    manager.scheduleRunOnceSession(21, 'left', [], '13:00', 'UTC')
    manager.scheduleRunOnceSession(22, 'right', [], '13:00', 'UTC')
    mockSelectRows([{ status: 'cancelled' }], [])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await required(captured.get('runonce-cleanup-21'), 'runonce-cleanup-21').handler()
    await required(captured.get('runonce-cleanup-22'), 'runonce-cleanup-22').handler()

    expect(log).toHaveBeenCalledWith('Run-once cleanup 21 skipped — status is cancelled')
    expect(log).toHaveBeenCalledWith('Run-once cleanup 22 skipped — status is missing')
    expect(hardwareClient.setPower).not.toHaveBeenCalled()
  })

  it('pins successful cleanup payload and completion log', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()
    manager.scheduleRunOnceSession(31, 'right', [], '13:00', 'UTC')
    mockSelectRows([{ status: 'active' }])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await required(captured.get('runonce-cleanup-31'), 'runonce-cleanup-31').handler()

    expect(hardwareClient.setPower).toHaveBeenCalledWith('right', false)
    expect(broadcastMutationStatus).toHaveBeenCalledWith('right', { targetLevel: 0 })
    expect(log).toHaveBeenCalledWith('Run-once session 31 completed — right powered off')
  })

  it('logs the exact cleanup hardware warning and still completes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const captured = captureOneTimeJobs()
    manager.scheduleRunOnceSession(32, 'left', [], '13:00', 'UTC')
    mockSelectRows([{ status: 'active' }])
    const failure = new Error('wake power failed')
    hardwareClient.setPower.mockRejectedValueOnce(failure)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      required(captured.get('runonce-cleanup-32'), 'runonce-cleanup-32').handler(),
    ).resolves.toBeUndefined()

    expect(warn).toHaveBeenCalledWith(
      '[runOnce] Failed to power off left at wake:',
      failure,
    )
  })

  it('expires a session at the exact boundary with exact payload and log', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-07-20T12:00:00.000Z')
    vi.setSystemTime(now)
    mockSelectRows([{
      id: 41,
      side: 'left',
      expiresAt: now,
    }], [])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await (manager as any).loadRunOnceSessions()

    expect(hardwareClient.setPower).toHaveBeenCalledWith('left', false)
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
    expect(log).toHaveBeenCalledWith('Expired run-once session 41 — left powered off')
  })

  it('logs the exact malformed-setPoints recovery message', async () => {
    mockSelectRows([], [{
      id: 42,
      side: 'right',
      setPoints: 'not-json',
    }])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await (manager as any).loadRunOnceSessions()

    expect(warn).toHaveBeenCalledWith(
      '[runOnce] Malformed setPoints for session 42, marking completed',
    )
  })

  it('restores the persisted timezone and logs the exact remaining count', async () => {
    const session = {
      id: 51,
      side: 'left',
      setPoints: '[]',
      startedAt: new Date('2026-07-20T08:00:00.000Z'),
      wakeTime: '13:00',
    }
    mockSelectRows([], [session], [{ timezone: 'UTC' }])
    const schedule = vi.spyOn(manager, 'scheduleRunOnceSession').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await (manager as any).loadRunOnceSessions()

    expect(schedule).toHaveBeenCalledWith(51, 'left', [], '13:00', 'UTC')
    expect(log).toHaveBeenCalledWith(
      'Restored run-once session 51 for left (0/0 points remaining)',
    )
  })

  it('uses the default timezone when device settings are absent', async () => {
    const session = {
      id: 52,
      side: 'right',
      setPoints: '[]',
      startedAt: new Date('2026-07-20T08:00:00.000Z'),
      wakeTime: '13:00',
    }
    mockSelectRows([], [session], [])
    const schedule = vi.spyOn(manager, 'scheduleRunOnceSession').mockImplementation(() => {})

    await expect((manager as any).loadRunOnceSessions()).resolves.toBeUndefined()

    expect(schedule).toHaveBeenCalledWith(
      52,
      'right',
      [],
      '13:00',
      'America/Los_Angeles',
    )
  })

  it('restores only points strictly later than now', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-20T12:00:00.000Z'))
    const session = {
      id: 53,
      side: 'left',
      setPoints: JSON.stringify([
        { time: '09:00', temperature: 80 },
        { time: '12:00', temperature: 78 },
        { time: '13:00', temperature: 76 },
      ]),
      startedAt: new Date('2026-07-20T08:00:00.000Z'),
      wakeTime: '14:00',
    }
    mockSelectRows([], [session], [{ timezone: 'UTC' }])
    const schedule = vi.spyOn(manager, 'scheduleRunOnceSession').mockImplementation(() => {})

    await (manager as any).loadRunOnceSessions()

    expect(schedule).toHaveBeenCalledWith(
      53,
      'left',
      [{ time: '13:00', temperature: 76 }],
      '14:00',
      'UTC',
    )
  })
})
