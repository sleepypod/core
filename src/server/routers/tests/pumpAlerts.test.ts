import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRPCError } from '@trpc/server'
import type * as DrizzleOrmModule from 'drizzle-orm'

const sql = vi.hoisted(() => ({
  and: vi.fn((...conditions: unknown[]) => ({ kind: 'and', conditions })),
  desc: vi.fn((column: unknown) => ({ kind: 'desc', column })),
  eq: vi.fn((left: unknown, right: unknown) => ({ kind: 'eq', left, right })),
  isNull: vi.fn((column: unknown) => ({ kind: 'isNull', column })),
}))

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrmModule>()
  return { ...actual, ...sql }
})

const dbState = vi.hoisted(() => ({
  queue: [] as unknown[],
  rejection: undefined as unknown,
  shouldReject: false,
  pop(): unknown {
    if (dbState.shouldReject) {
      dbState.shouldReject = false
      return Promise.reject(dbState.rejection)
    }
    return dbState.queue.shift() ?? []
  },
}))

const dbMock = vi.hoisted(() => {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'orderBy', 'limit', 'set', 'returning']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(dbState.pop()).then(resolve, reject)
  return {
    chain,
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
  }
})

const guard = vi.hoisted(() => ({
  acknowledge: vi.fn(),
}))

const notices = vi.hoisted(() => ({
  clearPumpStallNotice: vi.fn(),
}))

const device = vi.hoisted(() => ({
  setPower: vi.fn(),
  setTemperature: vi.fn(),
  createCaller: vi.fn(),
}))

vi.mock('@/src/db', () => ({ biometricsDb: dbMock }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ acknowledge: guard.acknowledge }))
vi.mock('@/src/hardware/pumpStallNotification', () => notices)
vi.mock('@/src/server/routers/app', () => ({
  appRouter: {
    createCaller: device.createCaller,
  },
}))

const { pumpAlertsRouter } = await import('@/src/server/routers/pumpAlerts')
const caller = pumpAlertsRouter.createCaller({})

const alert = {
  id: 17,
  timestamp: new Date('2026-07-20T01:00:00Z'),
  type: 'stall_left' as const,
  side: 'left' as const,
  rpm: 40,
  flowrateCd: 120,
  durationSeconds: 18,
  action: 'power_off' as const,
  restoreTargetTemperature: 72,
  restoreDurationSeconds: 3600,
  acknowledgedAt: null,
  dismissedAt: null,
}

function rejectNext(reason: unknown): void {
  dbState.shouldReject = true
  dbState.rejection = reason
}

beforeEach(() => {
  dbState.queue.length = 0
  dbState.shouldReject = false
  dbState.rejection = undefined
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  for (const value of Object.values(dbMock.chain)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as ReturnType<typeof vi.fn>).mockClear()
    }
  }
  Object.values(sql).forEach(mock => mock.mockClear())
  guard.acknowledge.mockReset().mockReturnValue({ restore: null, alertId: null })
  notices.clearPumpStallNotice.mockReset()
  device.setPower.mockReset().mockResolvedValue({ success: true })
  device.setTemperature.mockReset().mockResolvedValue({ success: true })
  device.createCaller.mockReset().mockReturnValue({
    device: {
      setPower: device.setPower,
      setTemperature: device.setTemperature,
    },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pumpAlerts OpenAPI contract', () => {
  it('publishes exact metadata for every procedure', () => {
    const expected = {
      list: { method: 'GET', path: '/pump-alerts' },
      getCapabilities: { method: 'GET', path: '/pump-alerts/capabilities' },
      acknowledgeAndRestore: { method: 'POST', path: '/pump-alerts/acknowledge' },
      dismissNotification: { method: 'POST', path: '/pump-alerts/dismiss-notification' },
      dismissAlert: { method: 'POST', path: '/pump-alerts/dismiss' },
    } as const

    for (const [name, route] of Object.entries(expected)) {
      const procedure = pumpAlertsRouter._def.record[name as keyof typeof expected]
      expect(procedure._def.meta, name).toEqual({
        openapi: {
          ...route,
          protect: false,
          tags: ['Pump Alerts'],
        },
      })
    }
  })
})

describe('pumpAlerts.list', () => {
  it('returns newest-first active unacknowledged rows using the defaults', async () => {
    dbState.queue.push([alert])

    await expect(caller.list({})).resolves.toEqual([alert])
    expect(sql.isNull).toHaveBeenCalledTimes(2)
    expect(sql.and).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'isNull' }),
      expect.objectContaining({ kind: 'isNull' }),
    )
    expect(dbMock.chain.orderBy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'desc' }))
    expect(dbMock.chain.limit).toHaveBeenCalledWith(50)
  })

  it('keeps acknowledged rows eligible when requested', async () => {
    dbState.queue.push([])

    await expect(caller.list({ includeAcknowledged: true, limit: 500 })).resolves.toEqual([])
    expect(sql.isNull).toHaveBeenCalledOnce()
    expect(sql.and.mock.calls[0]).toHaveLength(1)
    expect(dbMock.chain.limit).toHaveBeenCalledWith(500)
  })

  it.each([0, 501])('rejects an out-of-range limit of %i', async (limit) => {
    await expect(caller.list({ limit })).rejects.toThrow()
    expect(dbMock.select).not.toHaveBeenCalled()
  })

  it('wraps database Error details', async () => {
    rejectNext(new Error('sqlite busy'))
    await expect(caller.list({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch pump alerts: sqlite busy',
    })
  })

  it('uses Unknown error for a non-Error database rejection', async () => {
    rejectNext('sqlite unavailable')
    await expect(caller.list({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch pump alerts: Unknown error',
    })
  })
})

describe('pumpAlerts.getCapabilities', () => {
  const now = new Date('2026-07-20T01:00:00Z').getTime()

  it('reports center-sensor support only for a complete fresh row', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    dbState.queue.push([{
      timestamp: new Date(now - 10 * 60_000),
      leftCenterTemp: 2200,
      rightCenterTemp: 2250,
    }])

    await expect(caller.getCapabilities({})).resolves.toEqual({ hasBedCenterSensors: true })
    expect(dbMock.chain.limit).toHaveBeenCalledWith(1)
  })

  it.each([
    ['no row', undefined],
    ['missing left center sensor', { timestamp: new Date(now), leftCenterTemp: null, rightCenterTemp: 2200 }],
    ['missing right center sensor', { timestamp: new Date(now), leftCenterTemp: 2200, rightCenterTemp: null }],
    ['stale row', { timestamp: new Date(now - 10 * 60_000 - 1), leftCenterTemp: 2200, rightCenterTemp: 2200 }],
  ])('reports no support for %s', async (_label, row) => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
    dbState.queue.push(row == null ? [] : [row])
    await expect(caller.getCapabilities({})).resolves.toEqual({ hasBedCenterSensors: false })
  })

  it('wraps database Error details', async () => {
    rejectNext(new Error('probe failed'))
    await expect(caller.getCapabilities({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to probe pump-alert capabilities: probe failed',
    })
  })

  it('uses Unknown error for a non-Error database rejection', async () => {
    rejectNext({ unavailable: true })
    await expect(caller.getCapabilities({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to probe pump-alert capabilities: Unknown error',
    })
  })
})

describe('pumpAlerts.acknowledgeAndRestore', () => {
  it('acknowledges the guard without a restore or update when no snapshot and no orphan row exist', async () => {
    await expect(caller.acknowledgeAndRestore({ side: 'right' })).resolves.toEqual({
      success: true,
      restoredTarget: null,
      restoredDuration: null,
    })
    expect(guard.acknowledge).toHaveBeenCalledWith('right')
    expect(dbMock.update).not.toHaveBeenCalled()
    expect(device.createCaller).not.toHaveBeenCalled()
  })

  it('stamps acknowledgement and restores power and temperature through the device router', async () => {
    const restore = { targetTemperature: 71, durationSeconds: 5400 }
    guard.acknowledge.mockReturnValue({ restore, alertId: 42 })
    dbState.queue.push([])

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
      success: true,
      restoredTarget: 71,
      restoredDuration: 5400,
    })
    expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
    expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 42)
    expect(device.createCaller).toHaveBeenCalledWith({})
    expect(device.setPower).toHaveBeenCalledWith({ side: 'left', powered: true, temperature: 71 })
    expect(device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 71, duration: 5400 })
    expect(device.setPower.mock.invocationCallOrder[0]).toBeLessThan(device.setTemperature.mock.invocationCallOrder[0] ?? 0)
  })

  it('logs an acknowledgement stamp failure but still restores the side', async () => {
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 68, durationSeconds: 900 },
      alertId: 7,
    })
    rejectNext(new Error('read-only DB'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ restoredTarget: 68 })
    expect(warn).toHaveBeenCalledWith('[pumpAlerts] failed to stamp acknowledgedAt:', 'read-only DB')
    expect(device.setPower).toHaveBeenCalledOnce()
  })

  it('wraps an Error from the device restore path', async () => {
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      alertId: null,
    })
    device.setPower.mockRejectedValueOnce(new Error('hardware offline'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: hardware offline',
    })
    expect(device.setTemperature).not.toHaveBeenCalled()
  })

  it('uses Unknown error for a non-Error device restore rejection', async () => {
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      alertId: null,
    })
    device.setTemperature.mockRejectedValueOnce('transport closed')

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: Unknown error',
    })
  })

  describe('restart-orphaned alerts', () => {
    it('stamps the newest active power_off row for the side when the guard lost its alert id', async () => {
      // Simulated restart: the guard's in-memory state is empty, but the
      // trip's row is still active in the DB.
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      dbState.queue.push([{ id: 38 }]) // orphan lookup
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: null,
        restoredDuration: null,
      })
      expect(dbMock.select).toHaveBeenCalledOnce()
      expect(sql.and).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'eq' }),
        expect.objectContaining({ kind: 'eq', right: 'power_off' }),
        expect.objectContaining({ kind: 'isNull' }),
        expect.objectContaining({ kind: 'isNull' }),
      )
      expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 'left')
      expect(dbMock.chain.orderBy).toHaveBeenCalledWith(expect.objectContaining({ kind: 'desc' }))
      expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
      expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 38)
      // No in-memory snapshot survives a restart — nothing to restore.
      expect(device.createCaller).not.toHaveBeenCalled()
    })

    it('succeeds without an update when no active power_off row exists for the side', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      dbState.queue.push([]) // orphan lookup finds nothing

      await expect(caller.acknowledgeAndRestore({ side: 'right' })).resolves.toEqual({
        success: true,
        restoredTarget: null,
        restoredDuration: null,
      })
      expect(dbMock.select).toHaveBeenCalledOnce()
      expect(dbMock.update).not.toHaveBeenCalled()
    })

    it('skips the orphan lookup entirely when the guard still holds the alert id', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: 42 })
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(dbMock.select).not.toHaveBeenCalled()
      expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 42)
    })

    it('tolerates a failed orphan lookup and still resolves', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      rejectNext(new Error('sqlite locked'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(warn).toHaveBeenCalledWith('[pumpAlerts] orphaned-alert lookup failed:', 'sqlite locked')
      expect(dbMock.update).not.toHaveBeenCalled()
    })

    it('logs the raw value for a non-Error orphan lookup failure', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      rejectNext('sqlite unavailable')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(warn).toHaveBeenCalledWith('[pumpAlerts] orphaned-alert lookup failed:', 'sqlite unavailable')
      expect(dbMock.update).not.toHaveBeenCalled()
    })
  })
})

describe('pumpAlerts dismissals', () => {
  it('clears the notice without a DB update when the guard has no alert id', async () => {
    await expect(caller.dismissNotification({ side: 'left' })).resolves.toEqual({ success: true })
    expect(guard.acknowledge).toHaveBeenCalledWith('left')
    expect(notices.clearPumpStallNotice).toHaveBeenCalledWith('left')
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('stamps dismissedAt for the guard alert and tolerates a failed stamp', async () => {
    guard.acknowledge.mockReturnValue({ restore: null, alertId: 12 })
    rejectNext('write failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.dismissNotification({ side: 'right' })).resolves.toEqual({ success: true })
    expect(dbMock.chain.set).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) })
    expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 12)
    expect(warn).toHaveBeenCalledWith('[pumpAlerts] failed to stamp dismissedAt:', 'write failed')
  })

  it('dismisses a specific active history row', async () => {
    dbState.queue.push([alert])
    await expect(caller.dismissAlert({ id: 17 })).resolves.toEqual({ success: true })
    expect(dbMock.chain.set).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) })
    expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 17)
    expect(sql.isNull).toHaveBeenCalledOnce()
    expect(dbMock.chain.returning).toHaveBeenCalledOnce()
  })

  it('preserves NOT_FOUND when no active history row is updated', async () => {
    dbState.queue.push([])
    const error = await caller.dismissAlert({ id: 99 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Pump alert 99 not found or already dismissed',
    })
  })

  it('wraps an Error while dismissing a history row', async () => {
    rejectNext(new Error('disk full'))
    await expect(caller.dismissAlert({ id: 3 })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to dismiss pump alert: disk full',
    })
  })

  it('uses Unknown error for a non-Error history-row failure', async () => {
    rejectNext(false)
    await expect(caller.dismissAlert({ id: 3 })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to dismiss pump alert: Unknown error',
    })
  })
})
