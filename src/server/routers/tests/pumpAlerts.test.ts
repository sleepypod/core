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
  exhausted: false,
  pop(): unknown {
    if (dbState.shouldReject) {
      dbState.shouldReject = false
      return Promise.reject(dbState.rejection)
    }
    if (dbState.queue.length === 0) {
      // Loud on purpose: a silently-successful unexpected query hid real
      // DB traffic behind tolerant catch blocks. Every test enqueues every
      // expected result; the afterEach flag check catches swallowed throws.
      dbState.exhausted = true
      throw new Error('dbState queue exhausted — enqueue a result for every expected DB call')
    }
    return dbState.queue.shift()
  },
  popSync(): unknown {
    if (dbState.shouldReject) {
      dbState.shouldReject = false
      throw dbState.rejection
    }
    if (dbState.queue.length === 0) {
      dbState.exhausted = true
      throw new Error('dbState queue exhausted — enqueue a result for every expected DB call')
    }
    return dbState.queue.shift()
  },
}))

const dbMock = vi.hoisted(() => {
  const chain: Record<string, unknown> = {}
  for (const method of ['from', 'where', 'orderBy', 'limit', 'set', 'returning']) {
    chain[method] = vi.fn(() => chain)
  }
  chain.get = vi.fn(() => dbState.popSync())
  chain.then = vi.fn((resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(dbState.pop()).then(resolve, reject))
  const api = {
    chain,
    select: vi.fn(() => chain),
    update: vi.fn(() => chain),
    transaction: vi.fn((callback: (tx: unknown) => unknown) => callback(api)),
  }
  return api
})

const guard = vi.hoisted(() => ({
  acknowledge: vi.fn(),
  completeResolution: vi.fn(),
  identifyResolution: vi.fn(),
  restoreAcknowledgedSession: vi.fn(),
  rearm: vi.fn(),
  confirmCutoff: vi.fn(),
  supersedeAlerts: vi.fn(),
  dismissIfActive: vi.fn(),
  isCutoffPendingIncident: vi.fn(),
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
vi.mock('@/src/hardware/pumpStallGuard', () => ({
  acknowledge: guard.acknowledge,
  completeResolution: guard.completeResolution,
  identifyResolution: guard.identifyResolution,
  restoreAcknowledgedSession: guard.restoreAcknowledgedSession,
  rearm: guard.rearm,
  confirmCutoff: guard.confirmCutoff,
  supersedeAlerts: guard.supersedeAlerts,
  dismissIfActive: guard.dismissIfActive,
  isCutoffPendingIncident: guard.isCutoffPendingIncident,
}))
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

const resolutionToken = {}

function acknowledged(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    restore: null,
    alertId: null,
    trippedAt: null,
    conflict: null,
    rearmToken: resolutionToken,
    ...overrides,
  }
}

function rejectNext(reason: unknown): void {
  dbState.shouldReject = true
  dbState.rejection = reason
}

beforeEach(() => {
  dbState.queue.length = 0
  dbState.shouldReject = false
  dbState.rejection = undefined
  dbState.exhausted = false
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  dbMock.transaction.mockClear()
  for (const value of Object.values(dbMock.chain)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as ReturnType<typeof vi.fn>).mockClear()
    }
  }
  Object.values(sql).forEach(mock => mock.mockClear())
  guard.acknowledge.mockReset().mockReturnValue(acknowledged())
  guard.completeResolution.mockReset().mockReturnValue(true)
  guard.identifyResolution.mockReset().mockReturnValue(true)
  guard.restoreAcknowledgedSession.mockReset().mockImplementation(async (side, restore) => {
    await device.setTemperature({
      side,
      temperature: restore.targetTemperature,
      duration: restore.durationSeconds,
    })
  })
  guard.rearm.mockReset().mockReturnValue(true)
  guard.confirmCutoff.mockReset().mockReturnValue(true)
  guard.supersedeAlerts.mockReset().mockReturnValue(0)
  guard.dismissIfActive.mockReset().mockReturnValue(false)
  guard.isCutoffPendingIncident.mockReset().mockReturnValue(false)
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
  expect(dbState.exhausted, 'a DB call ran without an enqueued result').toBe(false)
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
    dbState.queue.push(undefined) // orphan lookup finds nothing

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
    expect(guard.completeResolution).toHaveBeenCalledWith('right', resolutionToken)
  })

  it('stamps acknowledgement after one duration-bearing restore write', async () => {
    const restore = { targetTemperature: 71, durationSeconds: 5400 }
    guard.acknowledge.mockReturnValue(acknowledged({ restore, alertId: 42 }))
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
    expect(device.setPower).not.toHaveBeenCalled()
    expect(device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 71, duration: 5400 })
    // acknowledgedAt is stamped only after the restore succeeds.
    expect(dbMock.update.mock.invocationCallOrder[0]).toBeGreaterThan(device.setTemperature.mock.invocationCallOrder[0] ?? Infinity)
  })

  it('ages the saved duration while the side is parked', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 71, durationSeconds: 5400 },
      alertId: 42,
      trippedAt: now - 110_000,
    }))
    dbState.queue.push([])

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
      success: true,
      restoredTarget: 71,
      restoredDuration: 5290,
      orphanRecovered: false,
    })
    expect(device.setPower).not.toHaveBeenCalled()
    expect(guard.restoreAcknowledgedSession).toHaveBeenCalledWith(
      'left',
      { targetTemperature: 71, durationSeconds: 5290 },
      resolutionToken,
    )
    expect(device.setTemperature).toHaveBeenCalledWith({
      side: 'left',
      temperature: 71,
      duration: 5290,
    })
  })

  it('leaves an expired short session off instead of starting another restore loop', async () => {
    const now = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 71, durationSeconds: 91 },
      alertId: 42,
      trippedAt: now - 92_000,
    }))
    dbState.queue.push([])

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
      success: true,
      restoredTarget: null,
      restoredDuration: null,
      orphanRecovered: false,
    })
    expect(device.createCaller).not.toHaveBeenCalled()
    expect(device.setPower).not.toHaveBeenCalled()
    expect(device.setTemperature).not.toHaveBeenCalled()
    expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
  })

  it('logs an acknowledgement stamp failure but still restores the side', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 68, durationSeconds: 900 },
      alertId: 7,
    }))
    rejectNext(new Error('read-only DB'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ restoredTarget: 68 })
    expect(warn).toHaveBeenCalledWith('[pumpAlerts] failed to stamp acknowledgedAt:', 'read-only DB')
    expect(device.setPower).not.toHaveBeenCalled()
    expect(guard.restoreAcknowledgedSession).toHaveBeenCalledOnce()
  })

  it('wraps an Error from the device restore path and re-arms without trip metadata', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      alertId: null,
    }))
    guard.restoreAcknowledgedSession.mockRejectedValueOnce(new Error('hardware offline'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: hardware offline',
    })
    expect(guard.restoreAcknowledgedSession).toHaveBeenCalledWith(
      'left',
      { targetTemperature: 69, durationSeconds: 1200 },
      resolutionToken,
    )
    // A duration write can fail after partially setting the target, so the
    // failure path re-arms first, then parks under that cutoff gate.
    expect(device.setPower).toHaveBeenCalledTimes(1)
    expect(device.setPower).toHaveBeenCalledWith({ side: 'left', powered: false })
    expect(guard.rearm).toHaveBeenCalledWith('left', {
      alertId: null,
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      trippedAt: undefined,
      rpm: undefined,
      cutoffPending: true,
    }, resolutionToken)
    expect(guard.confirmCutoff).toHaveBeenCalledWith('left', resolutionToken)
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('uses Unknown error for a non-Error device restore rejection', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      alertId: null,
    }))
    guard.restoreAcknowledgedSession.mockRejectedValueOnce('transport closed')

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: Unknown error',
    })
  })

  it('does not stamp and re-arms with the prior notice metadata when the restore fails', async () => {
    const now = 1_800_000_000_000
    const rearmToken = {}
    vi.spyOn(Date, 'now').mockReturnValue(now)
    notices.getPumpStallNotice.mockReturnValue({
      alertId: 7,
      trippedAt: now / 1000,
      rpm: 55,
      restore: { targetTemperature: 69, durationSeconds: 1200 },
    })
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      alertId: 7,
      conflict: null,
      rearmToken,
    })
    guard.restoreAcknowledgedSession.mockRejectedValueOnce(new Error('hardware offline'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
    })
    expect(notices.getPumpStallNotice).toHaveBeenCalledWith('left')
    expect(guard.rearm).toHaveBeenCalledWith('left', {
      alertId: 7,
      restore: { targetTemperature: 69, durationSeconds: 1200 },
      trippedAt: now,
      rpm: 55,
      cutoffPending: true,
    }, rearmToken)
    expect(guard.confirmCutoff).toHaveBeenCalledWith('left', rearmToken)
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('parks the side when the duration-bearing restore write fails', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 71, durationSeconds: 5400 },
      alertId: 42,
    }))
    guard.restoreAcknowledgedSession.mockRejectedValueOnce(new Error('setpoint refused'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: setpoint refused',
    })
    expect(device.setPower).toHaveBeenCalledTimes(1)
    expect(device.setPower).toHaveBeenLastCalledWith({ side: 'left', powered: false })
    expect(guard.rearm).toHaveBeenCalledWith(
      'left',
      expect.objectContaining({ alertId: 42 }),
      resolutionToken,
    )
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('still re-arms and warns when the post-failure park also fails', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({
      restore: { targetTemperature: 71, durationSeconds: 5400 },
      alertId: 42,
    }))
    device.setTemperature.mockRejectedValueOnce(new Error('setpoint refused'))
    device.setPower.mockRejectedValueOnce(new Error('park failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: setpoint refused',
    })
    expect(warn).toHaveBeenCalledWith('[pumpAlerts] failed to park side after partial restore:', 'park failed')
    expect(guard.rearm).toHaveBeenCalledWith(
      'left',
      expect.objectContaining({ alertId: 42 }),
      resolutionToken,
    )
    expect(guard.confirmCutoff).not.toHaveBeenCalled()
    expect(dbMock.update).not.toHaveBeenCalled()
  })

  it('does not park or rearm over a newer incident after a delayed restore failure', async () => {
    const rearmToken = {}
    guard.acknowledge.mockReturnValue({
      restore: { targetTemperature: 71, durationSeconds: 5400 },
      alertId: 42,
      conflict: null,
      rearmToken,
    })
    guard.rearm.mockReturnValueOnce(false)
    device.setTemperature.mockRejectedValueOnce(new Error('blocked by newer incident'))

    await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to restore side: blocked by newer incident',
    })
    expect(guard.rearm).toHaveBeenCalledWith(
      'left',
      expect.objectContaining({ alertId: 42, cutoffPending: true }),
      rearmToken,
    )
    expect(device.setPower).not.toHaveBeenCalled()
    expect(guard.confirmCutoff).not.toHaveBeenCalled()
  })

  describe('restart-orphaned alerts', () => {
    it('stamps the newest active power_off row for the side when the guard lost its alert id', async () => {
      // Simulated restart: the guard's in-memory state is empty, but the
      // trip's row is still active in the DB.
      guard.acknowledge.mockReturnValue(acknowledged())
      dbState.queue.push({ id: 38, restoreTargetTemperature: null, restoreDurationSeconds: null }) // orphan lookup
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
      // Newest by id, never timestamp — incident order survives the
      // pre-NTP boot clock skew that inverts wall timestamps.
      expect(sql.desc).toHaveBeenCalledWith(pumpAlerts.id)
      expect(sql.desc).not.toHaveBeenCalledWith(pumpAlerts.timestamp)
      expect(dbMock.chain.orderBy).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'desc', column: pumpAlerts.id }),
      )
      expect(dbMock.chain.limit).toHaveBeenCalledWith(1)
      expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.id, 38)
      expect(guard.identifyResolution).toHaveBeenCalledWith('left', resolutionToken, 38)
      expect(guard.completeResolution).toHaveBeenCalledWith('left', resolutionToken)
      // This row persisted no restore columns, so there is nothing to
      // replay — the side stays off.
      expect(device.createCaller).not.toHaveBeenCalled()
    })

    it('replays the aged persisted restore window when the side is still parked', async () => {
      const now = 1_800_000_000_000
      vi.spyOn(Date, 'now').mockReturnValue(now)
      guard.acknowledge.mockReturnValue(acknowledged())
      dbState.queue.push({
        id: 44,
        timestamp: new Date(now - 110_000),
        restoreTargetTemperature: 74,
        restoreDurationSeconds: 7200,
      }) // orphan lookup
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: 74,
        restoredDuration: 7090,
        orphanRecovered: true,
      })
      expect(device.getStatus).toHaveBeenCalledWith({})
      expect(device.setPower).not.toHaveBeenCalled()
      expect(device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 74, duration: 7090 })
      expect(device.getStatus.mock.invocationCallOrder[0]).toBeLessThan(device.setTemperature.mock.invocationCallOrder[0] ?? 0)
    })

    it('skips the replay when the side is already powered', async () => {
      guard.acknowledge.mockReturnValue(acknowledged())
      device.getStatus.mockResolvedValue({ leftSide: { targetLevel: 0 }, rightSide: { targetLevel: 2 } })
      dbState.queue.push({
        id: 45,
        timestamp: new Date(Date.now() - 110_000),
        restoreTargetTemperature: 74,
        restoreDurationSeconds: 7200,
      }) // orphan lookup
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
      guard.acknowledge.mockReturnValue(acknowledged())
      device.getStatus.mockRejectedValueOnce(new Error('status offline'))
      dbState.queue.push({
        id: 46,
        timestamp: new Date(Date.now() - 110_000),
        restoreTargetTemperature: 74,
        restoreDurationSeconds: 7200,
      }) // orphan lookup
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
      expect(device.setTemperature).not.toHaveBeenCalled()
    })

    it('skips the orphan lookup entirely when the guard still holds the alert id', async () => {
      guard.acknowledge.mockReturnValue(acknowledged({ alertId: 42 }))
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(dbMock.select).not.toHaveBeenCalled()
      // The stamp re-checks activity so a concurrently dismissed row is
      // not also acknowledged (TOCTOU with dismissAlert).
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.id, 42)
      expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.acknowledgedAt)
      expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.dismissedAt)
      expect(sql.and).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'eq' }),
        expect.objectContaining({ kind: 'isNull' }),
        expect.objectContaining({ kind: 'isNull' }),
      )
    })

    it('skips the fallback when the guard kept its restore snapshot (failed insert, not a restart)', async () => {
      // A failed alert INSERT at trip time leaves alertId null but keeps
      // the snapshot — the current trip has no row of its own, so falling
      // back would stamp an older, unrelated incident.
      guard.acknowledge.mockReturnValue(acknowledged({
        restore: { targetTemperature: 70, durationSeconds: 1800 },
        alertId: null,
      }))

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toEqual({
        success: true,
        restoredTarget: 70,
        restoredDuration: 1800,
        orphanRecovered: false,
      })
      expect(dbMock.select).not.toHaveBeenCalled()
      expect(dbMock.update).not.toHaveBeenCalled()
      expect(device.setPower).not.toHaveBeenCalled()
      expect(device.setTemperature).toHaveBeenCalledWith({ side: 'left', temperature: 70, duration: 1800 })
    })

    it('propagates a failed orphan lookup as INTERNAL_SERVER_ERROR', async () => {
      // The lookup is the mutation's only route to the stranded row —
      // swallowing the failure would report success with nothing stamped.
      guard.acknowledge.mockReturnValue(acknowledged())
      rejectNext(new Error('sqlite locked'))

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to look up orphaned pump alert: sqlite locked',
      })
      expect(dbMock.update).not.toHaveBeenCalled()
      expect(guard.completeResolution).toHaveBeenCalledWith('left', resolutionToken)
    })

    it('uses Unknown error for a non-Error orphan lookup failure', async () => {
      guard.acknowledge.mockReturnValue(acknowledged())
      rejectNext('sqlite unavailable')

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to look up orphaned pump alert: Unknown error',
      })
      expect(dbMock.update).not.toHaveBeenCalled()
      expect(guard.completeResolution).toHaveBeenCalledWith('left', resolutionToken)
    })
  })

  describe('identity correlation', () => {
    it('stamps exactly the client-provided alert id, constrained to this side\'s active power_off row', async () => {
      // Post-restart the guard is empty, but the client saw the banner and
      // still knows which incident it is acknowledging.
      guard.acknowledge.mockReturnValue(acknowledged())
      dbState.queue.push([]) // acknowledgedAt update

      await expect(caller.acknowledgeAndRestore({ side: 'left', alertId: 38 })).resolves.toEqual({
        success: true,
        restoredTarget: null,
        restoredDuration: null,
        orphanRecovered: false,
      })
      // No newest-row heuristic when the client names the row.
      expect(dbMock.select).not.toHaveBeenCalled()
      expect(dbMock.chain.set).toHaveBeenCalledWith({ acknowledgedAt: expect.any(Date) })
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.id, 38)
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.side, 'left')
      expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.action, 'power_off')
      expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.acknowledgedAt)
      expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.dismissedAt)
      expect(sql.and).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'eq' }),
        expect.objectContaining({ kind: 'isNull' }),
        expect.objectContaining({ kind: 'isNull' }),
        expect.objectContaining({ kind: 'eq' }),
        expect.objectContaining({ kind: 'eq', right: 'power_off' }),
      )
    })

    it('refuses a client id that no longer names the live incident', async () => {
      guard.acknowledge.mockReturnValue({
        restore: null,
        alertId: 42,
        conflict: 'alert_mismatch',
        rearmToken: null,
      })

      await expect(caller.acknowledgeAndRestore({ side: 'left', alertId: 38 })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Pump alert 38 is stale — the current incident is 42',
      })
      expect(guard.acknowledge).toHaveBeenCalledWith('left', 38)
      expect(dbMock.update).not.toHaveBeenCalled()
      expect(device.createCaller).not.toHaveBeenCalled()
    })

    it('refuses restore while the incident hardware transition is unconfirmed', async () => {
      guard.acknowledge.mockReturnValue({
        restore: null,
        alertId: 42,
        conflict: 'hardware_pending',
        rearmToken: null,
      })

      await expect(caller.acknowledgeAndRestore({ side: 'left', alertId: 42 })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'Pump alert 42 is still being resolved — the side is not confirmed off',
      })
      expect(dbMock.select).not.toHaveBeenCalled()
      expect(dbMock.update).not.toHaveBeenCalled()
      expect(device.createCaller).not.toHaveBeenCalled()
    })

    it('rejects a non-positive alert id', async () => {
      await expect(caller.acknowledgeAndRestore({ side: 'left', alertId: 0 })).rejects.toThrow()
      expect(dbMock.update).not.toHaveBeenCalled()
    })
  })

  describe('backlog supersede', () => {
    it('supersedes older rows for the side after a proven acknowledgement stamp', async () => {
      guard.acknowledge.mockReturnValue(acknowledged({ alertId: 42 }))
      dbState.queue.push([{ id: 42 }]) // acknowledgedAt update matched the row

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(guard.supersedeAlerts).toHaveBeenCalledWith('left', { beforeId: 42 })
    })

    it('does not supersede when the acknowledgement stamp matched no row', async () => {
      // A client id that failed the side/action proof (or a row already
      // resolved elsewhere) must not drive a bulk stamp for the side.
      guard.acknowledge.mockReturnValue(acknowledged({ alertId: 42 }))
      dbState.queue.push([]) // update matched nothing

      await expect(caller.acknowledgeAndRestore({ side: 'left' })).resolves.toMatchObject({ success: true })
      expect(guard.supersedeAlerts).not.toHaveBeenCalled()
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
    guard.acknowledge.mockReturnValue(acknowledged({ alertId: 12 }))
    rejectNext('write failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(caller.dismissNotification({ side: 'right' })).resolves.toEqual({ success: true })
    expect(dbMock.chain.set).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) })
    // Re-checks the row is not already dismissed (TOCTOU with dismissAlert).
    expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.id, 12)
    expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.dismissedAt)
    expect(sql.and).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'eq' }),
      expect.objectContaining({ kind: 'isNull' }),
    )
    expect(warn).toHaveBeenCalledWith('[pumpAlerts] failed to stamp dismissedAt:', 'write failed')
  })

  it('stamps the client-provided id with full identity constraints when the guard is empty', async () => {
    // Post-restart dismissal: the guard lost the id but the client kept it.
    guard.acknowledge.mockReturnValue(acknowledged())
    dbState.queue.push([]) // dismissedAt update

    await expect(caller.dismissNotification({ side: 'left', alertId: 31 })).resolves.toEqual({ success: true })
    expect(dbMock.select).not.toHaveBeenCalled()
    expect(dbMock.chain.set).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) })
    expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.id, 31)
    expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.side, 'left')
    expect(sql.eq).toHaveBeenCalledWith(pumpAlerts.action, 'power_off')
    expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.acknowledgedAt)
    expect(sql.isNull).toHaveBeenCalledWith(pumpAlerts.dismissedAt)
    expect(sql.and).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'eq' }),
      expect.objectContaining({ kind: 'isNull' }),
      expect.objectContaining({ kind: 'eq' }),
      expect.objectContaining({ kind: 'eq', right: 'power_off' }),
      expect.objectContaining({ kind: 'isNull' }),
    )
  })

  it('refuses a stale client id instead of dismissing the newer live incident', async () => {
    guard.acknowledge.mockReturnValue({
      restore: null,
      alertId: 12,
      conflict: 'alert_mismatch',
      rearmToken: null,
    })

    await expect(caller.dismissNotification({ side: 'right', alertId: 31 })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Pump alert 31 is stale — the current incident is 12',
    })
    expect(guard.acknowledge).toHaveBeenCalledWith('right', 31)
    expect(dbMock.update).not.toHaveBeenCalled()
    expect(notices.clearPumpStallNotice).not.toHaveBeenCalled()
  })

  it('refuses an id-less dismissal while hardware power-off is unconfirmed', async () => {
    guard.acknowledge.mockReturnValue({
      restore: null,
      alertId: null,
      conflict: 'hardware_pending',
      rearmToken: null,
    })

    await expect(caller.dismissNotification({ side: 'left' })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Pump alert incident is still being resolved — the side is not confirmed off',
    })
    expect(guard.acknowledge).toHaveBeenCalledWith('left')
    expect(dbMock.update).not.toHaveBeenCalled()
    expect(notices.clearPumpStallNotice).not.toHaveBeenCalled()
  })

  it('supersedes older rows after a proven dismissal stamp', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({ alertId: 12 }))
    dbState.queue.push([{ id: 12 }]) // dismissedAt update matched the row

    await expect(caller.dismissNotification({ side: 'right' })).resolves.toEqual({ success: true })
    expect(guard.supersedeAlerts).toHaveBeenCalledWith('right', { beforeId: 12 })
  })

  it('does not supersede when the dismissal stamp matched no row', async () => {
    guard.acknowledge.mockReturnValue(acknowledged({ alertId: 12 }))
    dbState.queue.push([]) // update matched nothing

    await expect(caller.dismissNotification({ side: 'right' })).resolves.toEqual({ success: true })
    expect(guard.supersedeAlerts).not.toHaveBeenCalled()
  })

  it('dismisses a specific active history row', async () => {
    dbState.queue.push(alert) // pre-stamp row read
    dbState.queue.push(alert) // dismissedAt update
    await expect(caller.dismissAlert({ id: 17 })).resolves.toEqual({ success: true })
    expect(dbMock.chain.set).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) })
    expect(sql.eq).toHaveBeenCalledWith(expect.anything(), 17)
    // The activity re-check appears in both the pre-stamp read and the update.
    expect(sql.isNull).toHaveBeenCalledTimes(2)
    expect(dbMock.chain.returning).toHaveBeenCalledOnce()
    expect(dbMock.transaction).toHaveBeenCalledOnce()
    expect(dbMock.chain.then).not.toHaveBeenCalled()
  })

  it('refuses with CONFLICT while the live incident row has an unconfirmed cutoff', async () => {
    guard.isCutoffPendingIncident.mockReturnValue(true)
    dbState.queue.push(alert) // pre-stamp row read

    const error = await caller.dismissAlert({ id: 17 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'Pump alert 17 is still being resolved — the side has not confirmed its power-off yet',
    })
    expect(guard.isCutoffPendingIncident).toHaveBeenCalledWith('left', 17)
    // Nothing may be stamped: the row is the only persistent trace of a
    // side possibly still energized against a stalled pump.
    expect(dbMock.update).not.toHaveBeenCalled()
    expect(guard.dismissIfActive).not.toHaveBeenCalled()
  })

  it('preserves NOT_FOUND when the row is dismissed between the read and the stamp', async () => {
    dbState.queue.push(alert) // pre-stamp row read
    dbState.queue.push(undefined) // update matched nothing — raced by another dismiss
    const error = await caller.dismissAlert({ id: 17 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({ code: 'NOT_FOUND' })
    expect(guard.dismissIfActive).not.toHaveBeenCalled()
  })

  it('releases the live block when the dismissed history row names the current incident', async () => {
    dbState.queue.push(alert) // pre-stamp row read
    dbState.queue.push(alert) // returning row: side left, id 17

    await expect(caller.dismissAlert({ id: 17 })).resolves.toEqual({ success: true })
    expect(guard.dismissIfActive).toHaveBeenCalledWith('left', 17)
  })

  it('skips the guard release and cutoff check for a sideless alert row', async () => {
    dbState.queue.push({ ...alert, side: null }) // pre-stamp row read
    dbState.queue.push({ ...alert, side: null }) // dismissedAt update

    await expect(caller.dismissAlert({ id: 17 })).resolves.toEqual({ success: true })
    expect(guard.isCutoffPendingIncident).not.toHaveBeenCalled()
    expect(guard.dismissIfActive).not.toHaveBeenCalled()
  })

  it('preserves NOT_FOUND when no active history row exists', async () => {
    dbState.queue.push(undefined) // pre-stamp row read finds nothing
    const error = await caller.dismissAlert({ id: 99 }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TRPCError)
    expect(error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Pump alert 99 not found or already dismissed',
    })
    expect(dbMock.update).not.toHaveBeenCalled()
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
