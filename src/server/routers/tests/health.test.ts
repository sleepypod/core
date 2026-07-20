/**
 * Tests for the health router — scheduler counts, system db+drift checks,
 * dacMonitor passthrough, hardware socket probe.
 *
 * Scheduler, db (sqlite + drizzle chain), shared hardware client, dacMonitor
 * accessor, and iptablesCheck are mocked. Drift auto-reload import path is
 * mocked too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DrizzleOrmModule from 'drizzle-orm'

const sqlMock = vi.hoisted(() => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  desc: vi.fn((column: unknown) => ({ op: 'desc', column })),
}))

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrmModule>()
  return { ...actual, ...sqlMock }
})

const schedulerMock = vi.hoisted(() => {
  const scheduler = {
    isEnabled: vi.fn(() => true),
    getJobs: vi.fn(() => [] as { id: string, type: string, metadata?: { side?: string } }[]),
    getNextInvocation: vi.fn<(id: string) => Date | null>(() => null),
  }
  const jobManager = {
    getScheduler: vi.fn(() => scheduler),
    reloadSchedules: vi.fn(async () => undefined),
  }
  const getJobManager = vi.fn(async () => jobManager)
  return { getJobManager, scheduler, jobManager }
})

// db-related — sqlite.pragma + db.select chain (uses .all())
const dbMock = vi.hoisted(() => {
  const sqlitePragma = vi.fn()
  const allSchedules = { temp: [] as unknown[], pow: [] as unknown[], alm: [] as unknown[] }
  let activeTable: 'temp' | 'pow' | 'alm' = 'temp'

  const all = vi.fn(() => {
    if (activeTable === 'temp') return allSchedules.temp
    if (activeTable === 'pow') return allSchedules.pow
    return allSchedules.alm
  })
  const where = vi.fn(() => ({ all }))
  const from = vi.fn((table: unknown) => {
    // Detect which schedule table is being queried. Drizzle tables all share
    // the constructor name SQLiteTable, so read the real table name from the
    // drizzle:Name symbol instead.
    const name = String(
      (table as Record<symbol, unknown> | undefined)?.[Symbol.for('drizzle:Name')] ?? '',
    )
    if (name.includes('power')) activeTable = 'pow'
    else if (name.includes('alarm')) activeTable = 'alm'
    else activeTable = 'temp'
    return { where }
  })
  const select = vi.fn(() => ({ from }))

  return {
    db: { select },
    sqlite: { pragma: sqlitePragma },
    sqlitePragma,
    allSchedules,
    setActive: (t: 'temp' | 'pow' | 'alm') => { activeTable = t },
  }
})

const sharedClientMock = vi.hoisted(() => {
  const client = { connect: vi.fn(async () => undefined) }
  return {
    getSharedHardwareClient: vi.fn(() => client),
    getDacMonitorIfRunning: vi.fn(),
    client,
  }
})

const iptablesMock = vi.hoisted(() => ({
  checkIptables: vi.fn(() => ({ ok: true, rules: [] })),
}))

vi.mock('@/src/scheduler', () => ({ getJobManager: schedulerMock.getJobManager }))
vi.mock('@/src/scheduler/instance', () => ({ getJobManager: schedulerMock.getJobManager }))
vi.mock('@/src/db', () => ({
  db: dbMock.db,
  sqlite: dbMock.sqlite,
  biometricsDb: {},
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: sharedClientMock.getSharedHardwareClient,
  getDacMonitorIfRunning: sharedClientMock.getDacMonitorIfRunning,
}))
vi.mock('@/src/hardware/iptablesCheck', () => iptablesMock)

const { healthRouter } = await import('@/src/server/routers/health')
const caller = healthRouter.createCaller({})

beforeEach(() => {
  schedulerMock.scheduler.isEnabled.mockReset().mockReturnValue(true)
  schedulerMock.scheduler.getJobs.mockReset().mockReturnValue([])
  schedulerMock.scheduler.getNextInvocation.mockReset().mockReturnValue(null)
  schedulerMock.jobManager.reloadSchedules.mockReset().mockResolvedValue(undefined)
  dbMock.sqlitePragma.mockReset()
  dbMock.allSchedules.temp.length = 0
  dbMock.allSchedules.pow.length = 0
  dbMock.allSchedules.alm.length = 0
  dbMock.db.select.mockClear()
  sharedClientMock.client.connect.mockReset().mockResolvedValue(undefined)
  sharedClientMock.getDacMonitorIfRunning.mockReset()
  iptablesMock.checkIptables.mockReset().mockReturnValue({ ok: true, rules: [] })
  Object.values(sqlMock).forEach(mock => mock.mockClear())
})

describe('health.scheduler', () => {
  it('returns counts and unhealthy=true when scheduler enabled but empty', async () => {
    schedulerMock.scheduler.isEnabled.mockReturnValue(true)
    schedulerMock.scheduler.getJobs.mockReturnValue([])

    const result = await caller.scheduler({})
    expect(result.enabled).toBe(true)
    expect(result.jobCounts.total).toBe(0)
    // The point: enabled with zero jobs → unhealthy
    expect(result.healthy).toBe(false)
  })

  it('returns healthy=true when scheduler is disabled regardless of count', async () => {
    schedulerMock.scheduler.isEnabled.mockReturnValue(false)
    schedulerMock.scheduler.getJobs.mockReturnValue([])

    const result = await caller.scheduler({})
    expect(result.healthy).toBe(true)
  })

  it('counts jobs by type and emits sorted upcoming list', async () => {
    schedulerMock.scheduler.getJobs.mockReturnValue([
      { id: 't-1', type: 'temperature', metadata: { side: 'left' } },
      { id: 'p-on-1', type: 'power_on', metadata: { side: 'left' } },
      { id: 'p-off-1', type: 'power_off', metadata: { side: 'left' } },
      { id: 'a-1', type: 'alarm', metadata: { side: 'right' } },
      { id: 'pr-1', type: 'prime' },
      { id: 'rb-1', type: 'reboot' },
    ])
    const now = Date.now()
    schedulerMock.scheduler.getNextInvocation.mockImplementation((id: string) => {
      const offsets: Record<string, number> = {
        't-1': 1000,
        'p-on-1': 500,
        'p-off-1': 2000,
        'a-1': 100,
        'pr-1': 10000,
        'rb-1': 50000,
      }
      return new Date(now + offsets[id])
    })

    const result = await caller.scheduler({})
    expect(result.jobCounts).toEqual({
      temperature: 1, powerOn: 1, powerOff: 1, alarm: 1,
      prime: 1, reboot: 1, total: 6,
    })
    // Sorted ascending: a-1 (100ms), p-on-1, t-1, p-off-1, pr-1, rb-1
    expect(result.upcomingJobs.map(j => j.id)).toEqual(['a-1', 'p-on-1', 't-1', 'p-off-1', 'pr-1', 'rb-1'])
    expect(result.healthy).toBe(true)
  })

  it('caps the upcoming scheduler list at ten jobs', async () => {
    schedulerMock.scheduler.getJobs.mockReturnValue(Array.from({ length: 11 }, (_, index) => ({
      id: `job-${index}`,
      type: 'temperature',
    })))
    schedulerMock.scheduler.getNextInvocation.mockImplementation((id: string) => {
      const index = Number(id.slice('job-'.length))
      return new Date(Date.UTC(2026, 6, 20, 0, index))
    })

    const result = await caller.scheduler({})
    expect(result.upcomingJobs).toHaveLength(10)
    expect(result.upcomingJobs.map(job => job.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `job-${index}`),
    )
  })

  it('drops jobs without a next invocation and exposes typed metadata exactly', async () => {
    schedulerMock.scheduler.getJobs.mockReturnValue([
      { id: 'missing', type: 'temperature', metadata: { side: 'left' } },
      { id: 'later', type: 'temperature', metadata: { side: 'right', targetTemperature: 73, brightness: 15 } },
      { id: 'earlier', type: 'temperature', metadata: { side: 'left', targetTemperature: '73', brightness: '15' } },
    ] as never)
    schedulerMock.scheduler.getNextInvocation.mockImplementation((id: string) => {
      if (id === 'missing') return null
      return new Date(id === 'earlier' ? '2026-07-20T01:00:00Z' : '2026-07-20T02:00:00Z')
    })

    expect((await caller.scheduler({})).upcomingJobs).toEqual([
      {
        id: 'earlier',
        type: 'temperature',
        side: 'left',
        nextRun: '2026-07-20T01:00:00.000Z',
        targetTempF: null,
        brightness: null,
      },
      {
        id: 'later',
        type: 'temperature',
        side: 'right',
        nextRun: '2026-07-20T02:00:00.000Z',
        targetTempF: 73,
        brightness: 15,
      },
    ])
  })

  it('wraps internal errors as INTERNAL_SERVER_ERROR', async () => {
    schedulerMock.getJobManager.mockRejectedValueOnce(new Error('scheduler down'))

    await expect(caller.scheduler({})).rejects.toThrow(/Failed to get scheduler health/)
  })

  it('uses Unknown error for a non-Error scheduler failure', async () => {
    schedulerMock.getJobManager.mockRejectedValueOnce('scheduler missing')
    await expect(caller.scheduler({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get scheduler health: Unknown error',
    })
  })
})

describe('health.system', () => {
  it('reports ok when db responds and scheduler matches DB schedules', async () => {
    dbMock.sqlitePragma.mockReturnValue(undefined)
    dbMock.allSchedules.temp.push({ id: 1 })
    dbMock.allSchedules.pow.push({ id: 1 })
    dbMock.allSchedules.alm.push({ id: 1 })
    // Expected: 1 temp + (1 power * 2) + 1 alarm = 4 user jobs
    schedulerMock.scheduler.getJobs.mockReturnValue([
      { id: 'a', type: 'temperature' },
      { id: 'b', type: 'power_on' },
      { id: 'c', type: 'power_off' },
      { id: 'd', type: 'alarm' },
    ])

    const result = await caller.system({})
    expect(result.status).toBe('ok')
    expect(result.database.status).toBe('ok')
    expect(dbMock.sqlitePragma).toHaveBeenCalledWith('quick_check(1)')
    expect(result.scheduler.enabled).toBe(true)
    expect(result.scheduler.drift?.drifted).toBe(false)
    expect(result.scheduler.drift).toEqual({ dbScheduleCount: 4, schedulerJobCount: 4, drifted: false })
    expect(sqlMock.eq).toHaveBeenCalledTimes(3)
    expect(sqlMock.eq.mock.calls.map(call => call[1])).toEqual([true, true, true])
    const scheduleSelections = dbMock.db.select.mock.calls as unknown as Array<[Record<string, unknown>]>
    expect(scheduleSelections.map(call => Object.keys(call[0]))).toEqual([
      ['id'],
      ['id'],
      ['id'],
    ])
    expect(result.iptables.ok).toBe(true)
  })

  it('reports degraded when sqlite pragma throws', async () => {
    dbMock.sqlitePragma.mockImplementation(() => {
      throw new Error('db locked')
    })
    schedulerMock.scheduler.getJobs.mockReturnValue([])

    const result = await caller.system({})
    expect(result.database.status).toBe('degraded')
    expect(result.database.error).toBe('db locked')
    expect(result.status).toBe('degraded')
  })

  it('reports Unknown error when sqlite throws a non-Error value', async () => {
    dbMock.sqlitePragma.mockImplementation(() => {
      throw { locked: true }
    })
    const result = await caller.system({})
    expect(result.database).toMatchObject({ status: 'degraded', error: 'Unknown error' })
    expect(result.status).toBe('degraded')
  })

  it('rounds database latency to two decimal places', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(101.234)
    const result = await caller.system({})
    expect(result.database.latencyMs).toBe(1.23)
  })

  it('excludes PRIME / REBOOT system jobs from drift comparison', async () => {
    dbMock.allSchedules.temp.push({ id: 1 })
    schedulerMock.scheduler.getJobs.mockReturnValue([
      { id: 't-1', type: 'temperature' },
      { id: 'prime', type: 'prime' },
      { id: 'reboot', type: 'reboot' },
    ])
    const result = await caller.system({})
    expect(result.scheduler.drift?.drifted).toBe(false)
    expect(result.scheduler.drift?.schedulerJobCount).toBe(1)
  })

  it('does not flag drift for LED/away/run-once/calibration jobs', async () => {
    // Regression: these job types have no schedule row; counting them on
    // only one side of the comparison made every health poll reload the
    // whole scheduler (~7s cron rebuild).
    dbMock.allSchedules.temp.push({ id: 1 })
    schedulerMock.scheduler.getJobs.mockReturnValue([
      { id: 't-1', type: 'temperature' },
      { id: 'led-am', type: 'led_brightness' },
      { id: 'led-pm', type: 'led_brightness' },
      { id: 'away', type: 'away_mode' },
      { id: 'ro-1', type: 'run_once' },
      { id: 'cal', type: 'calibration' },
      { id: 'prime', type: 'prime' },
      { id: 'reboot', type: 'reboot' },
    ])

    const result = await caller.system({})
    expect(result.scheduler.drift?.drifted).toBe(false)
    expect(result.scheduler.drift?.schedulerJobCount).toBe(1)
    expect(schedulerMock.jobManager.reloadSchedules).not.toHaveBeenCalled()
  })

  it('auto-reloads scheduler when drift detected and clears drifted flag on success', async () => {
    dbMock.allSchedules.temp.push({ id: 1 })
    schedulerMock.scheduler.getJobs.mockReturnValue([])
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    const result = await caller.system({})
    expect(schedulerMock.jobManager.reloadSchedules).toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith('[health] Schedule drift detected — auto-reloaded scheduler')
    expect(result.scheduler.drift?.drifted).toBe(false)
    expect(result.status).toBe('ok')
    log.mockRestore()
  })

  it('marks system degraded when drift auto-reload throws', async () => {
    dbMock.allSchedules.temp.push({ id: 1 })
    schedulerMock.scheduler.getJobs.mockReturnValue([])
    schedulerMock.jobManager.reloadSchedules.mockRejectedValueOnce(new Error('reload failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await caller.system({})
    expect(result.status).toBe('degraded')
    expect(errSpy).toHaveBeenCalledWith('[health] Failed to auto-reload scheduler:', expect.any(Error))
    errSpy.mockRestore()
  })

  it('marks system degraded when iptables critical rules are missing', async () => {
    iptablesMock.checkIptables.mockReturnValueOnce({
      ok: false,
      rules: [
        { name: 'critical-rule', present: false, critical: true },
        { name: 'optional-rule', present: false, critical: false },
        { name: 'present-rule', present: true, critical: true },
      ],
    } as unknown as ReturnType<typeof iptablesMock.checkIptables>)
    const result = await caller.system({})
    expect(result.iptables.ok).toBe(false)
    expect(result.iptables.missing).toEqual(['critical-rule'])
    expect(result.status).toBe('degraded')
  })

  it('marks system degraded when scheduler getJobManager rejects', async () => {
    schedulerMock.getJobManager.mockRejectedValueOnce(new Error('scheduler down'))
    const result = await caller.system({})
    expect(result.status).toBe('degraded')
    expect(result.scheduler.enabled).toBe(false)
    expect(result.scheduler.jobCount).toBe(0)
  })

  it('uses permissive empty iptables defaults when the checker is unavailable', async () => {
    iptablesMock.checkIptables.mockImplementationOnce(() => {
      throw new Error('iptables unavailable')
    })

    const result = await caller.system({})
    expect(result.iptables).toEqual({ ok: true, missing: [] })
  })
})

describe('health.dacMonitor', () => {
  it('returns not_initialized when monitor is null', async () => {
    sharedClientMock.getDacMonitorIfRunning.mockReturnValue(null)
    const result = await caller.dacMonitor({})
    expect(result).toEqual({ status: 'not_initialized', podVersion: null, gesturesSupported: false })
  })

  it('returns monitor status + gestures flag when running', async () => {
    sharedClientMock.getDacMonitorIfRunning.mockReturnValue({
      getStatus: () => 'running',
      getLastStatus: () => ({ podVersion: 'I00', gestures: { doubleTap: { l: 1, r: 0 } } }),
    })

    const result = await caller.dacMonitor({})
    expect(result.status).toBe('running')
    expect(result.podVersion).toBe('I00')
    expect(result.gesturesSupported).toBe(true)
  })

  it('uses null/false fallbacks when a running monitor has no last status', async () => {
    sharedClientMock.getDacMonitorIfRunning.mockReturnValue({
      getStatus: () => 'starting',
      getLastStatus: () => undefined,
    })
    await expect(caller.dacMonitor({})).resolves.toEqual({
      status: 'starting',
      podVersion: null,
      gesturesSupported: false,
    })
  })
})

describe('health.hardware', () => {
  it('returns ok with measured latency when connect resolves', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(10).mockReturnValueOnce(12.345)
    const result = await caller.hardware({})
    expect(result.status).toBe('ok')
    expect(result.latencyMs).toBe(2.35)
    expect(result.socketPath).toBe(process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock')
    expect(result.error).toBeUndefined()
  })

  it('returns degraded with error message when connect fails', async () => {
    sharedClientMock.client.connect.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await caller.hardware({})
    expect(result.status).toBe('degraded')
    expect(result.error).toBe('ECONNREFUSED')
  })

  it('uses Unknown error for a non-Error connection rejection', async () => {
    sharedClientMock.client.connect.mockRejectedValue({ disconnected: true })
    await expect(caller.hardware({})).resolves.toMatchObject({
      status: 'degraded',
      latencyMs: 0,
      error: 'Unknown error',
    })
  })
})
