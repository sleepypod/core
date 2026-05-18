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
    await manager.shutdown()
  })

  it('getScheduler exposes the underlying Scheduler', () => {
    const sched = manager.getScheduler()
    expect(sched).toBeDefined()
    expect(typeof sched.scheduleJob).toBe('function')
    expect(sched.getTimezone()).toBe('UTC')
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

  it('startHeartbeat / stopHeartbeat are idempotent', () => {
    manager.startHeartbeat()
    manager.startHeartbeat() // second call no-ops
    manager.stopHeartbeat()
    manager.stopHeartbeat() // double-stop is safe
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

  // Same-day window: current is inside but past a mutated end. A smaller
  // mutated end (22*60-30=1290) would flip it to outside → kills + → - on
  // endMinutes (and / 60).
  it('night brightness when current is just inside the end of a tight window — kills + → - on endMinutes', async () => {
    const { sendLed } = run('2026-01-15T22:15:00Z')
    await (manager as any).scheduleLedNightMode('22:00', '22:30', 80, 10)
    expect(sendLed).toHaveBeenLastCalledWith(10)
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
    )
    expect(scheduleJob).toHaveBeenCalledWith(
      'led-night-end',
      JobType.LED_BRIGHTNESS,
      '45 6 * * *',
      expect.any(Function),
    )
  })

  // Pin that the registered callbacks actually call sendLedBrightness
  // with the correct per-job brightness. Kills BlockStatement mutators on
  // the two scheduleJob arrow bodies (lines 519-522, 527-530).
  it('scheduled callbacks send the correct brightness for night vs day', async () => {
    const { sendLed, scheduleJob } = run('2026-01-15T12:00:00Z')
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

    await endCb()
    expect(sendLed).toHaveBeenLastCalledWith(80) // morning → day brightness
  })
})
