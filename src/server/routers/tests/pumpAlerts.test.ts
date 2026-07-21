import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TRPCError } from '@trpc/server'
import type * as DrizzleOrmModule from 'drizzle-orm'
import { pumpAlerts } from '@/src/db/biometrics-schema'

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
  rearm: vi.fn(),
}))

const notices = vi.hoisted(() => ({
  clearPumpStallNotice: vi.fn(),
  getPumpStallNotice: vi.fn(),
}))

const device = vi.hoisted(() => ({
  setPower: vi.fn(),
  setTemperature: vi.fn(),
  getStatus: vi.fn(),
  createCaller: vi.fn(),
}))

vi.mock('@/src/db', () => ({ biometricsDb: dbMock }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ acknowledge: guard.acknowledge, rearm: guard.rearm }))
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
  guard.rearm.mockReset()
  notices.clearPumpStallNotice.mockReset()
  notices.getPumpStallNotice.mockReset().mockReturnValue(null)
  device.setPower.mockReset().mockResolvedValue({ success: true })
  device.setTemperature.mockReset().mockResolvedValue({ success: true })
  device.getStatus.mockReset().mockResolvedValue({
    leftSide: { targetLevel: 0 },
    rightSide: { targetLevel: 0 },
  })
  device.createCaller.mockReset().mockReturnValue({
    device: {
      setPower: device.setPower,
      setTemperature: device.setTemperature,
      getStatus: device.getStatus,
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
    dbState.queue.push([]) // orphan lookup finds nothing

    await expect(caller.acknowledgeAndRestore({ side: 'right' })).resolves.toEqual({
      success: true,
      restoredTarget: null,
      restoredDuration: null,
      orphanRecovered: false,
    })
    expect(guard.acknowledge).toHaveBeenCalledWith('right')
    expect(dbMock.select).toHaveBeenCalledOnce()
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
      orphanRecovered: false,
    })
    expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
    expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 42)
    expect(device.createCaller).toHaveBeenCalledWith({})
    expect(device.setPower).toHaveBeenCalledWith({ side: 'left', powered: true, temperature: 71 })
    expect(device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 71, duration: 5400 })
    expect(device.setPower.mock.invocationCallOrder[0]).toBeLessThan(device.setTemperature.mock.invocationCallOrder[0] ?? 0)
    // acknowledgedAt is stamped only after both restore calls succeed.
    expect(dbMock.update.mock.invocationCallOrder[0]).toBeGreaterThan(device.setTemperature.mock.invocationCallOrder[0] ?? Infinity)
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

  it('wraps an Error from the device restore path and re-arms without trip metadata', async () => {
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
    // Power-on itself failed, so there is nothing to park again.
    expect(device.setPower).toHaveBeenCalledTimes(1)
    expect(guard.rearm).toHaveBeenCalledWith('left', {
      alertId: null,
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      trippedAt: undefined,
      rpm: undefined,
    })
    expect(dbMock.update).not.toHaveBeenCalled()
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

  it('does not stamp and re-arms with the prior notice metadata when the restore fails', async () => {
    notices.getPumpStallNotice.mockReturnValue({
      alertId: 7,
      trippedAt: 1_720_000_000,
      rpm: 55,
      restore: { targetTemperature: 69, durationSeconds: 1200 },
    })
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      alertId: 7,
    })
    device.setPower.mockRejectedValueOnce(new Error('hardware offline'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
    expect(notices.getPumpStallNotice).toHaveBeenCalledWith('left')
    expect(guard.rearm).toHaveBeenCalledWith('left', {
      alertId: 7,
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      trippedAt: 1_720_000_000_000,
      rpm: 55,
    })
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('parks the side again when the setpoint fails after a successful power-on', async () => {
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 71, durationSeconds: 5400 },
      alertId: 42,
    })
    device.setTemperature.mockRejectedValueOnce(new Error('setpoint refused'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: setpoint refused',
    })
    expect(device.setPower).toHaveBeenCalledTimes(2)
    expect(device.setPower).toHaveBeenLastCalledWith({ side: 'left', powered: false })
    expect(guard.rearm).toHaveBeenCalledWith('left', expect.objectContaining({ alertId: 42 }))
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('still re-arms and warns when the post-failure park also fails', async () => {
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 71, durationSeconds: 5400 },
      alertId: 42,
    })
    device.setTemperature.mockRejectedValueOnce(new Error('setpoint refused'))
    device.setPower
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('park failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: setpoint refused',
    })
    expect(warn).toHaveBeenCalledWith('[pumpAlerts] failed to park side after partial restore:', 'park failed')
    expect(guard.rearm).toHaveBeenCalledWith('left', expect.objectContaining({ alertId: 42 }))
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  describe('restart-orphaned alerts', () => {
    it('stamps the newest active power_off row for the side when the guard lost its alert id', async () => {
      // Simulated restart: the guard's in-memory state is empty, but the
      // trip's row is still active in the DB.
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      dbState.queue.push([{ id: 38, restoreTargetTemperature: null, restoreDurationSeconds: null }]) // orphan lookup
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: null,
        restoredDuration: null,
        orphanRecovered: true,
      })
      expect(dbMock.select).toHaveBeenCalledOnce()
      expect(sql.and).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'eq' }),
        expect.objectContaining({ kind: 'eq', right: 'power_off' }),
        expect.objectContaining({ kind: 'isNull' }),
        expect.objectContaining({ kind: 'isNull' }),
      )
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.side, 'left')
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.action, 'power_off')
      expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.acknowledgedAt)
      expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.dismissedAt)
      expect(sql.desc).toHaveBeenCalledWith(pumpAlerts.timestamp)
      expect(sql.desc).toHaveBeenCalledWith(pumpAlerts.id)
      expect(dbMock.chain.orderBy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'desc', column: pumpAlerts.timestamp }),
        expect.objectContaining({ kind: 'desc', column: pumpAlerts.id }),
      )
      expect(dbMock.chain.limit).toHaveBeenCalledWith(1)
      expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.id, 38)
      // This row persisted no restore columns, so there is nothing to
      // replay — the side stays off.
      expect(device.createCaller).not.toHaveBeenCalled()
    })

    it('replays the persisted restore columns when the side is still parked', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      dbState.queue.push([{ id: 44, restoreTargetTemperature: 74, restoreDurationSeconds: 7200 }]) // orphan lookup
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: 74,
        restoredDuration: 7200,
        orphanRecovered: true,
      })
      expect(device.getStatus).toHaveBeenCalledWith({})
      expect(device.setPower).toHaveBeenCalledWith({ side: 'left', powered: true, temperature: 74 })
      expect(device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 74, duration: 7200 })
      expect(device.getStatus.mock.invocationCallOrder[0]).toBeLessThan(device.setPower.mock.invocationCallOrder[0] ?? 0)
    })

    it('skips the replay when the side is already powered', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      device.getStatus.mockResolvedValue({ leftSide: { targetLevel: 0 }, rightSide: { targetLevel: 2 } })
      dbState.queue.push([{ id: 45, restoreTargetTemperature: 74, restoreDurationSeconds: 7200 }]) // orphan lookup
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'right' })).resolves.toEqual({
        success: true,
        restoredTarget: null,
        restoredDuration: null,
        orphanRecovered: true,
      })
      expect(device.setPower).not.toHaveBeenCalled()
      expect(device.setTemperature).not.toHaveBeenCalled()
    })

    it('skips the replay and warns when the pre-replay status read fails', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      device.getStatus.mockRejectedValueOnce(new Error('status offline'))
      dbState.queue.push([{ id: 46, restoreTargetTemperature: 74, restoreDurationSeconds: 7200 }]) // orphan lookup
      dbState.queue.push([]) // acknowledgedAt update
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: null,
        restoredDuration: null,
        orphanRecovered: true,
      })
      expect(warn).toHaveBeenCalledWith('[pumpAlerts] status read before orphan replay failed — leaving the side off:', 'status offline')
      expect(device.setPower).not.toHaveBeenCalled()
    })

    it('skips the orphan lookup entirely when the guard still holds the alert id', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: 42 })
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(dbMock.select).not.toHaveBeenCalled()
      expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 42)
    })

    it('skips the fallback when the guard kept its restore snapshot (failed insert, not a restart)', async () => {
      // A failed alert INSERT at trip time leaves alertId null but keeps
      // the snapshot — the current trip has no row of its own, so falling
      // back would stamp an older, unrelated incident.
      guard.acknowledge.mockReturnValue({
        restore: { targetTemperature: 70, durationSeconds: 1800 },
        alertId: null,
      })

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: 70,
        restoredDuration: 1800,
        orphanRecovered: false,
      })
      expect(dbMock.select).not.toHaveBeenCalled()
      expect(dbMock.update).not.toHaveBeenCalled()
      expect(device.setPower).toHaveBeenCalledWith({ side: 'left', powered: true, temperature: 70 })
    })

    it('propagates a failed orphan lookup as INTERNAL_SERVER_ERROR', async () => {
      // The lookup is the mutation's only route to the stranded row —
      // swallowing the failure would report success with nothing stamped.
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      rejectNext(new Error('sqlite locked'))

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to look up orphaned pump alert: sqlite locked',
      })
      expect(dbMock.update).not.toHaveBeenCalled()
    })

    it('uses Unknown error for a non-Error orphan lookup failure', async () => {
      guard.acknowledge.mockReturnValue({ restore: null, alertId: null })
      rejectNext('sqlite unavailable')

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to look up orphaned pump alert: Unknown error',
      })
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
