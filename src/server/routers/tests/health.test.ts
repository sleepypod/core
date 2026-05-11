/**
 * Tests for the health router — scheduler counts, system db+drift checks,
 * dacMonitor passthrough, hardware socket probe.
 *
 * Scheduler, db (sqlite + drizzle chain), shared hardware client, dacMonitor
 * accessor, and iptablesCheck are mocked. Drift auto-reload import path is
 * mocked too.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    // Detect which schedule table is being queried
    const name = String(table?.constructor?.name ?? '')
    if (name.includes('Power')) activeTable = 'pow'
    else if (name.includes('Alarm')) activeTable = 'alm'
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
  sharedClientMock.client.connect.mockReset().mockResolvedValue(undefined)
  sharedClientMock.getDacMonitorIfRunning.mockReset()
  iptablesMock.checkIptables.mockReset().mockReturnValue({ ok: true, rules: [] })
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

  it('wraps internal errors as INTERNAL_SERVER_ERROR', async () => {
    schedulerMock.getJobManager.mockRejectedValueOnce(new Error('scheduler down'))

    await expect(caller.scheduler({})).rejects.toThrow(/Failed to get scheduler health/)
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
    expect(result.scheduler.enabled).toBe(true)
    expect(result.scheduler.drift?.drifted).toBe(false)
    expect(result.iptables.ok).toBe(true)
  })

  it('reports degraded when sqlite pragma throws', async () => {
    dbMock.sqlitePragma.mockImplementation(() => { throw new Error('db locked') })
    schedulerMock.scheduler.getJobs.mockReturnValue([])

    const result = await caller.system({})
    expect(result.database.status).toBe('degraded')
    expect(result.database.error).toBe('db locked')
    expect(result.status).toBe('degraded')
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
})

describe('health.hardware', () => {
  it('returns ok with measured latency when connect resolves', async () => {
    const result = await caller.hardware({})
    expect(result.status).toBe('ok')
    expect(typeof result.latencyMs).toBe('number')
    expect(result.error).toBeUndefined()
  })

  it('returns degraded with error message when connect fails', async () => {
    sharedClientMock.client.connect.mockRejectedValue(new Error('ECONNREFUSED'))

    const result = await caller.hardware({})
    expect(result.status).toBe('degraded')
    expect(result.error).toBe('ECONNREFUSED')
  })
})
