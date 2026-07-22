/**
 * Tests for the device router. Exercises every procedure's happy path plus
 * a key branch (debounce coalesce, snooze timestamp, raw command allowlist).
 *
 * Hardware client, DB, broadcast helper, snooze/prime modules and the raw
 * dac transport are fully mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const helpersMock = vi.hoisted(() => {
  const client = {
    getDeviceStatus: vi.fn(),
    setPower: vi.fn(),
    setTemperature: vi.fn(),
    setAlarm: vi.fn(),
    clearAlarm: vi.fn(),
    startPriming: vi.fn(),
  }
  const withHardwareClient = vi.fn(async (
    cb: (c: typeof client) => Promise<unknown>,
    errorMessage: string,
  ) => {
    void errorMessage
    return cb(client)
  })
  return { withHardwareClient, client }
})

const primeMock = vi.hoisted(() => ({
  getPrimeCompletedAt: vi.fn(),
  dismissPrimeNotification: vi.fn(),
}))

const snoozeMock = vi.hoisted(() => ({
  snoozeAlarm: vi.fn(),
  cancelSnooze: vi.fn(),
  getSnoozeStatus: vi.fn<(side?: string) => { active: boolean, snoozeUntil: number | null }>(() => ({ active: false, snoozeUntil: null })),
}))

const broadcastMock = vi.hoisted(() => ({
  broadcastMutationStatus: vi.fn(),
}))

const transportMock = vi.hoisted(() => ({
  sendCommand: vi.fn(),
  isDacConnected: vi.fn(() => true),
  connectDac: vi.fn(),
}))

const sharedClientMock = vi.hoisted(() => {
  const sendRaw = vi.fn()
  return {
    sendRaw,
    getSharedHardwareClient: vi.fn(() => ({ sendRaw })),
  }
})

const stateSyncMock = vi.hoisted(() => ({
  markSideMutated: vi.fn(),
}))

const pumpStallMock = vi.hoisted(() => ({
  shouldBlock: vi.fn<(side: 'left' | 'right') => boolean>(() => false),
}))

const pumpStallNotificationMock = vi.hoisted(() => ({
  getAllPumpStallNotices: vi.fn<() => { left: unknown, right: unknown }>(() => ({ left: null, right: null })),
}))

const automationMock = vi.hoisted(() => ({
  registerManualOverride: vi.fn(),
  getAutomationEngineIfRunning: vi.fn(() => ({ registerManualOverride: automationMock.registerManualOverride })),
}))

const dbState = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  pop(): unknown[] { return dbState.rowsQueue.shift() ?? [] },
}))

const dbMock = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.pop()).then(resolve)
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.onConflictDoUpdate = vi.fn(() => chain)
    chain.returning = vi.fn(() => chain)
    return chain
  }
  return {
    select: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
  }
})

// biometricsDb is read inside the enrichment block of getStatus; tests
// drive it through `biometricsRowsQueue`.
const biometricsState = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  pop(): unknown[] { return biometricsState.rowsQueue.shift() ?? [] },
  throwOnSelect: false,
}))
const biometricsDbMock = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(biometricsState.pop()).then(resolve)
    chain.from = vi.fn(() => chain)
    chain.where = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    return chain
  }
  return {
    select: vi.fn(() => {
      if (biometricsState.throwOnSelect) throw new Error('biometrics down')
      return makeChain()
    }),
  }
})

const wifiMock = vi.hoisted(() => ({
  getWifiInfo: vi.fn<() => { wifiStrength: number, wifiSSID: string }>(() => ({ wifiStrength: -1, wifiSSID: 'unknown' })),
}))

vi.mock('@/src/server/helpers', async () => {
  const { TRPCError } = await import('@trpc/server')
  return {
    withHardwareClient: helpersMock.withHardwareClient,
    // Mirrors the real helper but consults this file's pumpStallMock so
    // tests keep driving the guard through shouldBlock.
    assertPumpStallNotBlocked: (side: 'left' | 'right') => {
      if (pumpStallMock.shouldBlock(side)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Pump stall protection active — re-enable the side first',
        })
      }
    },
  }
})
vi.mock('@/src/hardware/primeNotification', () => primeMock)
vi.mock('@/src/hardware/snoozeManager', () => snoozeMock)
vi.mock('@/src/streaming/broadcastMutationStatus', () => broadcastMock)
vi.mock('@/src/hardware/dacTransport', () => transportMock)
vi.mock('@/src/hardware/sharedClient', () => ({ getSharedHardwareClient: sharedClientMock.getSharedHardwareClient }))
vi.mock('@/src/hardware/deviceStateSync', () => stateSyncMock)
vi.mock('@/src/hardware/pumpStallGuard', () => pumpStallMock)
vi.mock('@/src/hardware/pumpStallNotification', () => pumpStallNotificationMock)
vi.mock('@/src/automation', () => ({ getAutomationEngineIfRunning: automationMock.getAutomationEngineIfRunning }))
vi.mock('@/src/db', () => ({
  db: dbMock,
  biometricsDb: biometricsDbMock,
}))
vi.mock('@/src/hardware/wifi', () => wifiMock)

const { deviceRouter } = await import('@/src/server/routers/device')
const { withSideLock } = await import('@/src/hardware/sideLock')
const caller = deviceRouter.createCaller({})

function dbChain(method: 'insert' | 'update', index = 0) {
  return dbMock[method].mock.results[index]?.value as {
    values?: ReturnType<typeof vi.fn>
    set?: ReturnType<typeof vi.fn>
    onConflictDoUpdate?: ReturnType<typeof vi.fn>
  }
}

beforeEach(() => {
  helpersMock.withHardwareClient.mockClear()
  Object.values(helpersMock.client).forEach(fn => fn.mockReset())
  helpersMock.client.getDeviceStatus.mockResolvedValue({
    leftSide: { currentTemperature: 80, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
    rightSide: { currentTemperature: 80, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
    waterLevel: 'ok',
    isPriming: false,
    podVersion: 'I00',
    sensorLabel: 'pod-test',
  })
  helpersMock.client.setPower.mockResolvedValue(undefined)
  helpersMock.client.setTemperature.mockResolvedValue(undefined)
  helpersMock.client.setAlarm.mockResolvedValue(undefined)
  helpersMock.client.clearAlarm.mockResolvedValue(undefined)
  helpersMock.client.startPriming.mockResolvedValue(undefined)

  primeMock.getPrimeCompletedAt.mockReset().mockReturnValue(null)
  primeMock.dismissPrimeNotification.mockReset()
  snoozeMock.snoozeAlarm.mockReset()
  snoozeMock.cancelSnooze.mockReset()
  snoozeMock.getSnoozeStatus.mockReset().mockReturnValue({ active: false, snoozeUntil: null })
  broadcastMock.broadcastMutationStatus.mockReset()
  transportMock.sendCommand.mockReset()
  sharedClientMock.sendRaw.mockReset()
  stateSyncMock.markSideMutated.mockReset()
  pumpStallMock.shouldBlock.mockReset().mockReturnValue(false)
  pumpStallNotificationMock.getAllPumpStallNotices.mockReset().mockReturnValue({ left: null, right: null })
  automationMock.registerManualOverride.mockReset()
  automationMock.getAutomationEngineIfRunning.mockClear()
  dbState.rowsQueue.length = 0
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  dbMock.insert.mockClear()
  biometricsState.rowsQueue.length = 0
  biometricsState.throwOnSelect = false
  biometricsDbMock.select.mockClear()
  wifiMock.getWifiInfo.mockReset().mockReturnValue({ wifiStrength: -1, wifiSSID: 'unknown' })
})

describe('device.getStatus', () => {
  it('returns status with snooze block and converts to F by default', async () => {
    primeMock.getPrimeCompletedAt.mockReturnValue(1700000000000)
    snoozeMock.getSnoozeStatus.mockReturnValueOnce({ active: true, snoozeUntil: 1700001000000 })
    snoozeMock.getSnoozeStatus.mockReturnValueOnce({ active: false, snoozeUntil: null })

    const result = await caller.getStatus({})
    expect(result.leftSide.currentTemperature).toBe(80)
    expect(result.snooze.left.active).toBe(true)
    expect(result.primeCompletedNotification?.timestamp).toBe(1700000000000)
  })

  it('converts to Celsius when unit=C', async () => {
    const result = await caller.getStatus({ unit: 'C' })
    // 80°F → 26.7°C (rounded to one decimal by router)
    expect(result.leftSide.currentTemperature).toBeCloseTo(26.7, 1)
  })

  it('passes null temps through for an off side (no phantom 83°F)', async () => {
    // The parser returns null for a level-0 (off) side; getStatus must surface
    // that null rather than the 82.5°F→83°F neutral readback.
    helpersMock.client.getDeviceStatus.mockResolvedValueOnce({
      leftSide: { currentTemperature: null, targetTemperature: null, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
      rightSide: { currentTemperature: 72, targetTemperature: 75, currentLevel: -35, targetLevel: -25, heatingDuration: 0 },
      waterLevel: 'ok', isPriming: false, podVersion: 'J00', sensorLabel: 'X', gestures: undefined,
    })
    const result = await caller.getStatus({})
    expect(result.leftSide.targetTemperature).toBeNull()
    expect(result.leftSide.currentTemperature).toBeNull()
    expect(result.rightSide.targetTemperature).toBe(75)
  })

  it('exposes pumpStallNotifications when one side has an active notice', async () => {
    pumpStallNotificationMock.getAllPumpStallNotices.mockReturnValueOnce({
      left: null,
      right: { alertId: 42, trippedAt: 1700000000, rpm: 50, restore: null },
    })
    const result = await caller.getStatus({})
    expect(result.pumpStallNotifications?.right?.alertId).toBe(42)
    expect(result.pumpStallNotifications?.left).toBeNull()
  })

  it('exposes pumpStallNotifications when only the left side has an active notice', async () => {
    pumpStallNotificationMock.getAllPumpStallNotices.mockReturnValueOnce({
      left: { alertId: 43, trippedAt: 1700000000, rpm: 50, restore: null },
      right: null,
    })
    const result = await caller.getStatus({})
    expect(result.pumpStallNotifications?.left?.alertId).toBe(43)
    expect(result.pumpStallNotifications?.right).toBeNull()
  })

  it('omits pumpStallNotifications when both sides are null', async () => {
    pumpStallNotificationMock.getAllPumpStallNotices.mockReturnValueOnce({ left: null, right: null })
    const result = await caller.getStatus({})
    expect(result.pumpStallNotifications).toBeUndefined()
  })

  // ─── enrichment (#157/#192): wifi, room climate, water level ──────────
  it('enriches with wifi info, roomClimate, and waterLevelRaw when data is present', async () => {
    wifiMock.getWifiInfo.mockReturnValueOnce({ wifiStrength: 72, wifiSSID: 'home-net' })
    const ts = new Date(1700000000000)
    biometricsState.rowsQueue.push([{ ambientTemp: 2150, humidity: 4500, timestamp: ts }])
    biometricsState.rowsQueue.push([{ raw: 1234, calibratedEmpty: 500, calibratedFull: 2000, timestamp: ts }])

    const result = await caller.getStatus({})
    expect(result.wifiStrength).toBe(72)
    expect(result.wifiSSID).toBe('home-net')
    // 2150 centi°C → 21.5°C; 4500 centi-% → 45%
    expect(result.roomClimate.temperatureC).toBeCloseTo(21.5, 1)
    expect(result.roomClimate.humidity).toBeCloseTo(45, 1)
    expect(result.roomClimate.timestamp).toBe(ts.getTime())
    expect(result.waterLevelRaw).toEqual({
      raw: 1234, calibratedEmpty: 500, calibratedFull: 2000, timestamp: ts.getTime(),
    })
  })

  it('emits null roomClimate/waterLevelRaw fields when bedTemp/water rows are absent', async () => {
    wifiMock.getWifiInfo.mockReturnValueOnce({ wifiStrength: 50, wifiSSID: 'x' })
    // Both queries return [] (no rows). Wifi still populates.
    const result = await caller.getStatus({})
    expect(result.wifiStrength).toBe(50)
    expect(result.roomClimate).toEqual({ temperatureC: null, humidity: null, timestamp: null })
    expect(result.waterLevelRaw).toEqual({ raw: null, calibratedEmpty: null, calibratedFull: null, timestamp: null })
  })

  it('handles bedTemp rows with null ambientTemp/humidity/timestamp fields', async () => {
    wifiMock.getWifiInfo.mockReturnValueOnce({ wifiStrength: 10, wifiSSID: 'y' })
    biometricsState.rowsQueue.push([{ ambientTemp: null, humidity: null, timestamp: null }])
    biometricsState.rowsQueue.push([])

    const result = await caller.getStatus({})
    expect(result.roomClimate).toEqual({ temperatureC: null, humidity: null, timestamp: null })
  })

  it('handles water rows with undefined raw/calibrated/timestamp fields', async () => {
    wifiMock.getWifiInfo.mockReturnValueOnce({ wifiStrength: 0, wifiSSID: 'z' })
    biometricsState.rowsQueue.push([])
    biometricsState.rowsQueue.push([{ raw: undefined, calibratedEmpty: undefined, calibratedFull: undefined, timestamp: null }])

    const result = await caller.getStatus({})
    expect(result.waterLevelRaw).toEqual({
      raw: null, calibratedEmpty: null, calibratedFull: null, timestamp: null,
    })
  })

  it('still enriches water data when there is no bed-temperature row', async () => {
    const timestamp = new Date('2026-07-20T10:00:00Z')
    biometricsState.rowsQueue.push([])
    biometricsState.rowsQueue.push([{
      raw: 1234,
      calibratedEmpty: 500,
      calibratedFull: 2000,
      timestamp,
    }])

    const result = await caller.getStatus({})
    expect(result.roomClimate).toEqual({ temperatureC: null, humidity: null, timestamp: null })
    expect(result.waterLevelRaw).toEqual({
      raw: 1234,
      calibratedEmpty: 500,
      calibratedFull: 2000,
      timestamp: timestamp.getTime(),
    })
  })

  it('falls back to defaults when the enrichment block throws (best-effort)', async () => {
    biometricsState.throwOnSelect = true
    wifiMock.getWifiInfo.mockImplementationOnce(() => {
      throw new Error('proc unreadable')
    })

    const result = await caller.getStatus({})
    expect(result.wifiStrength).toBe(-1)
    expect(result.wifiSSID).toBe('unknown')
    expect(result.roomClimate.temperatureC).toBeNull()
    expect(result.waterLevelRaw.raw).toBeNull()
  })

  it('persists both sides with exact powered flags in insert and conflict-update payloads', async () => {
    helpersMock.client.getDeviceStatus.mockResolvedValueOnce({
      leftSide: { currentTemperature: null, targetTemperature: null, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
      rightSide: { currentTemperature: 70, targetTemperature: 74, currentLevel: -10, targetLevel: -30, heatingDuration: 4 },
      waterLevel: 'ok', isPriming: false, podVersion: 'J00', sensorLabel: 'X', gestures: undefined,
    })

    await caller.getStatus({})
    expect(dbMock.insert).toHaveBeenCalledTimes(2)
    expect(dbChain('insert', 0).values).toHaveBeenCalledWith({
      side: 'left',
      currentTemperature: null,
      targetTemperature: null,
      isPowered: false,
      lastUpdated: expect.any(Date),
    })
    expect(dbChain('insert', 0).onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.anything(),
      set: {
        currentTemperature: null,
        targetTemperature: null,
        isPowered: false,
        lastUpdated: expect.any(Date),
      },
    })
    expect(dbChain('insert', 1).values).toHaveBeenCalledWith({
      side: 'right',
      currentTemperature: 70,
      targetTemperature: 74,
      isPowered: true,
      lastUpdated: expect.any(Date),
    })
    expect(dbChain('insert', 1).onConflictDoUpdate).toHaveBeenCalledWith({
      target: expect.anything(),
      set: {
        currentTemperature: 70,
        targetTemperature: 74,
        isPowered: true,
        lastUpdated: expect.any(Date),
      },
    })
  })

  it('derives the opposite powered flags for both insert and conflict-update payloads', async () => {
    helpersMock.client.getDeviceStatus.mockResolvedValueOnce({
      leftSide: { currentTemperature: 70, targetTemperature: 74, currentLevel: -10, targetLevel: -30, heatingDuration: 4 },
      rightSide: { currentTemperature: null, targetTemperature: null, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
      waterLevel: 'ok', isPriming: false, podVersion: 'J00', sensorLabel: 'X', gestures: undefined,
    })

    await caller.getStatus({})

    expect(dbChain('insert', 0).values).toHaveBeenCalledWith(expect.objectContaining({
      side: 'left',
      isPowered: true,
    }))
    expect(dbChain('insert', 0).onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ isPowered: true }),
    }))
    expect(dbChain('insert', 1).values).toHaveBeenCalledWith(expect.objectContaining({
      side: 'right',
      isPowered: false,
    }))
    expect(dbChain('insert', 1).onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      set: expect.objectContaining({ isPowered: false }),
    }))
  })

  it('logs the exact DB-sync failure and still returns hardware status', async () => {
    dbMock.insert.mockImplementationOnce(() => {
      throw new Error('sqlite read-only')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await caller.getStatus({})
    expect(result.sensorLabel).toBe('pod-test')
    expect(error).toHaveBeenCalledWith('Failed to sync device status to DB:', expect.any(Error))
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to get device status')
  })
})

describe('device.setTemperature', () => {
  it('waits behind an existing shared side lock before writing hardware', async () => {
    vi.useFakeTimers()
    let releaseLock: () => void = () => {}
    const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
      releaseLock = resolve
    }))
    await Promise.resolve()

    try {
      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
      const promise = caller.setTemperature({ side: 'left', temperature: 70 })
      await vi.advanceTimersByTimeAsync(250)
      await Promise.resolve()

      expect(helpersMock.client.setTemperature).not.toHaveBeenCalled()

      releaseLock()
      await holder
      await promise

      expect(helpersMock.client.setTemperature).toHaveBeenCalledWith('left', 70, undefined)
    }
    finally {
      releaseLock()
      await holder.catch(() => {})
      vi.useRealTimers()
    }
  })

  it('debounces and resolves after timer fires', async () => {
    vi.useFakeTimers()
    try {
      // Provide a prior deviceState row for the prev lookup
      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])

      const promise = caller.setTemperature({ side: 'left', temperature: 70 })
      await vi.advanceTimersByTimeAsync(250)
      const result = await promise

      expect(result).toEqual({ success: true })
      expect(helpersMock.client.setTemperature).toHaveBeenCalledTimes(1)
      expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalled()
      expect(stateSyncMock.markSideMutated).toHaveBeenCalledWith('left')
      expect(automationMock.registerManualOverride).toHaveBeenCalledWith('left')
      expect(dbChain('update').set).toHaveBeenCalledWith({
        targetTemperature: 70,
        isPowered: true,
        poweredOnAt: expect.any(Date),
        lastUpdated: expect.any(Date),
      })
      expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', {
        targetTemperature: 70,
        targetLevel: expect.any(Number),
      })
      expect(helpersMock.withHardwareClient.mock.calls.at(-1)?.[1]).toBe('Failed to set temperature')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('preserves poweredOnAt when changing temperature on an already-powered side', async () => {
    vi.useFakeTimers()
    const poweredOnAt = new Date('2026-07-19T20:00:00Z')
    try {
      dbState.rowsQueue.push([{ isPowered: true, poweredOnAt }])
      const pending = caller.setTemperature({ side: 'right', temperature: 69, duration: 600 })
      await vi.advanceTimersByTimeAsync(250)
      await pending
      expect(dbChain('update').set).toHaveBeenCalledWith(expect.objectContaining({
        targetTemperature: 69,
        isPowered: true,
        poweredOnAt,
      }))
      expect(helpersMock.client.setTemperature).toHaveBeenCalledWith('right', 69, 600)
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('stamps poweredOnAt when changing temperature without a prior device-state row', async () => {
    vi.useFakeTimers()
    try {
      const pending = caller.setTemperature({ side: 'left', temperature: 71 })
      await vi.advanceTimersByTimeAsync(250)
      await pending

      expect(dbChain('update').set).toHaveBeenCalledWith({
        targetTemperature: 71,
        isPowered: true,
        poweredOnAt: expect.any(Date),
        lastUpdated: expect.any(Date),
      })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('throws PRECONDITION_FAILED when pump stall guard blocks the side', async () => {
    pumpStallMock.shouldBlock.mockReturnValueOnce(true)
    await expect(caller.setTemperature({ side: 'left', temperature: 70 })).rejects.toThrow(/Pump stall protection active/)
    expect(helpersMock.client.setTemperature).not.toHaveBeenCalled()
    expect(automationMock.registerManualOverride).not.toHaveBeenCalled()
  })

  it('re-checks the guard inside the side lock — a trip during the debounce window blocks the queued command', async () => {
    vi.useFakeTimers()
    try {
      // Early check passes, then the guard trips while the command is debounced.
      pumpStallMock.shouldBlock.mockReturnValueOnce(false).mockReturnValue(true)
      const pending = caller.setTemperature({ side: 'left', temperature: 70 })
      const assertion = expect(pending).rejects.toThrow(/Pump stall protection active/)
      await vi.advanceTimersByTimeAsync(250)
      await assertion
      expect(helpersMock.client.setTemperature).not.toHaveBeenCalled()
      // A rejected command must not suspend autopilot.
      expect(automationMock.registerManualOverride).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('restores the parked DB mirror and broadcasts off when the in-lock recheck rejects', async () => {
    vi.useFakeTimers()
    try {
      pumpStallMock.shouldBlock.mockReturnValueOnce(false).mockReturnValue(true)
      dbState.rowsQueue.push([{ isPowered: true, poweredOnAt: new Date() }])
      const pending = caller.setTemperature({ side: 'left', temperature: 70 })
      const assertion = expect(pending).rejects.toThrow(/Pump stall protection active/)
      await vi.advanceTimersByTimeAsync(250)
      await assertion
      // update #0 is the optimistic energized write; update #1 must put the
      // parked mirror back so the UI doesn't keep an energized target.
      expect(dbChain('update', 1).set).toHaveBeenCalledWith({
        isPowered: false,
        poweredOnAt: null,
        targetTemperature: null,
        lastUpdated: expect.any(Date),
      })
      expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('blocks a debounced command queued behind a held side lock when the trip lands while queued', async () => {
    vi.useFakeTimers()
    try {
      let tripped = false
      pumpStallMock.shouldBlock.mockImplementation(() => tripped)
      let release: () => void = () => {}
      const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
        release = resolve
      }))
      await vi.advanceTimersByTimeAsync(0)

      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
      const pending = caller.setTemperature({ side: 'left', temperature: 70 })
      const assertion = expect(pending).rejects.toThrow(/Pump stall protection active/)
      // Debounce fires and the write queues behind the held lock, all while
      // the guard is still healthy — the flip below happens strictly after.
      await vi.advanceTimersByTimeAsync(250)
      tripped = true
      release()
      await holder
      await assertion
      expect(helpersMock.client.setTemperature).not.toHaveBeenCalled()
      expect(automationMock.registerManualOverride).not.toHaveBeenCalled()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('swallows DB sync errors so the timer still fires', async () => {
    vi.useFakeTimers()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      dbMock.select.mockImplementationOnce(() => {
        throw new Error('db down')
      })

      const promise = caller.setTemperature({ side: 'left', temperature: 70 })
      await vi.advanceTimersByTimeAsync(250)
      const result = await promise

      expect(result).toEqual({ success: true })
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to sync temperature state to DB'),
        expect.any(Error),
      )
    }
    finally {
      vi.useRealTimers()
      errSpy.mockRestore()
    }
  })

  it('rejects the debounced promise when the deferred hardware call fails', async () => {
    vi.useFakeTimers()
    try {
      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
      helpersMock.withHardwareClient.mockRejectedValueOnce(new Error('hw down'))

      const promise = caller.setTemperature({ side: 'left', temperature: 70 })
      // Swallow synchronously so vitest does not flag an unhandled rejection
      // when the timer fires before the assertion below awaits the promise.
      const caught = promise.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(250)
      const err = await caught
      expect(err).toBeInstanceOf(Error)
      expect((err as Error).message).toMatch(/hw down/)
      // Only guard rejections compensate the optimistic write — a hardware
      // failure leaves the single optimistic update in place.
      expect(dbMock.update).toHaveBeenCalledTimes(1)
      expect(broadcastMock.broadcastMutationStatus).not.toHaveBeenCalledWith('left', { targetLevel: 0 })
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('coalesces a second call into one hardware command (last value wins)', async () => {
    vi.useFakeTimers()
    try {
      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
      dbState.rowsQueue.push([{ isPowered: true, poweredOnAt: new Date() }])

      // Start call 1 and let it register its pending entry (await microtasks
      // so the async DB lookup before pendingTemps.set has a chance to settle).
      const p1 = caller.setTemperature({ side: 'left', temperature: 70 })
      await vi.advanceTimersByTimeAsync(0)
      // Call 2 now sees the pending entry and cancels the first timer.
      const p2 = caller.setTemperature({ side: 'left', temperature: 75 })
      await vi.advanceTimersByTimeAsync(250)
      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1).toEqual({ success: true })
      expect(r2).toEqual({ success: true })
      // Only the second call's value reaches hardware
      expect(helpersMock.client.setTemperature).toHaveBeenCalledTimes(1)
      expect(helpersMock.client.setTemperature).toHaveBeenCalledWith('left', 75, undefined)
      // One executed hardware write → one override registration; the
      // coalesced first call must not register a second one.
      expect(automationMock.registerManualOverride).toHaveBeenCalledTimes(1)
      expect(automationMock.registerManualOverride).toHaveBeenLastCalledWith('left')
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('device.setPower', () => {
  it('waits behind an existing shared side lock without blocking the opposite side', async () => {
    let releaseLeft: () => void = () => {}
    const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
      releaseLeft = resolve
    }))
    await Promise.resolve()

    try {
      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
      const left = caller.setPower({ side: 'left', powered: true, temperature: 72 })
      await Promise.resolve()
      expect(helpersMock.client.setPower).not.toHaveBeenCalled()

      dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
      await caller.setPower({ side: 'right', powered: true, temperature: 73 })
      expect(helpersMock.client.setPower).toHaveBeenCalledWith('right', true, 73)
      expect(helpersMock.client.setPower).not.toHaveBeenCalledWith('left', true, 72)

      releaseLeft()
      await holder
      await left

      expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', true, 72)
    }
    finally {
      releaseLeft()
      await holder.catch(() => {})
    }
  })

  it('powers on with the provided temperature, broadcasts, syncs DB', async () => {
    dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])

    const result = await caller.setPower({ side: 'left', powered: true, temperature: 72 })
    expect(result).toEqual({ success: true })
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', true, 72)
    expect(automationMock.registerManualOverride).toHaveBeenCalledWith('left')
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', expect.objectContaining({
      targetTemperature: 72,
    }))
    expect(dbChain('update').set).toHaveBeenCalledWith({
      isPowered: true,
      poweredOnAt: expect.any(Date),
      targetTemperature: 72,
      lastUpdated: expect.any(Date),
    })
    expect(stateSyncMock.markSideMutated).toHaveBeenCalledWith('left')
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to set power')
  })

  it('persists an OFF-to-ON transition without a prior device-state row', async () => {
    await caller.setPower({ side: 'right', powered: true, temperature: 72 })

    expect(dbChain('update').set).toHaveBeenCalledWith({
      isPowered: true,
      poweredOnAt: expect.any(Date),
      targetTemperature: 72,
      lastUpdated: expect.any(Date),
    })
    expect(stateSyncMock.markSideMutated).toHaveBeenCalledWith('right')
  })

  it('powers off and broadcasts targetLevel: 0', async () => {
    dbState.rowsQueue.push([{ isPowered: true, poweredOnAt: new Date() }])

    await caller.setPower({ side: 'left', powered: false })
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', false, undefined)
    expect(automationMock.registerManualOverride).toHaveBeenCalledWith('left')
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
    expect(dbChain('update').set).toHaveBeenCalledWith({
      isPowered: false,
      poweredOnAt: null,
      targetTemperature: null,
      lastUpdated: expect.any(Date),
    })
  })

  it('defaults an omitted on-temperature to 75 in both DB state and broadcast', async () => {
    dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
    await caller.setPower({ side: 'right', powered: true })
    expect(dbChain('update').set).toHaveBeenCalledWith(expect.objectContaining({ targetTemperature: 75 }))
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('right', {
      targetTemperature: 75,
      targetLevel: expect.any(Number),
    })
  })

  it('preserves the original poweredOnAt on an ON→ON mutation', async () => {
    const poweredOnAt = new Date('2026-07-18T12:00:00Z')
    dbState.rowsQueue.push([{ isPowered: true, poweredOnAt }])
    await caller.setPower({ side: 'left', powered: true, temperature: 68 })
    expect(dbChain('update').set).toHaveBeenCalledWith(expect.objectContaining({ poweredOnAt, targetTemperature: 68 }))
  })

  it('throws PRECONDITION_FAILED when powering on while pump stall guard is active', async () => {
    pumpStallMock.shouldBlock.mockReturnValueOnce(true)
    await expect(caller.setPower({ side: 'left', powered: true, temperature: 72 })).rejects.toThrow(/Pump stall protection active/)
    expect(helpersMock.client.setPower).not.toHaveBeenCalled()
    expect(automationMock.registerManualOverride).not.toHaveBeenCalled()
  })

  it('re-checks the guard inside the side lock before sending power-on', async () => {
    // Early check passes; the trip lands while the command queues on the lock.
    pumpStallMock.shouldBlock.mockReturnValueOnce(false).mockReturnValue(true)
    await expect(caller.setPower({ side: 'left', powered: true, temperature: 72 })).rejects.toThrow(/Pump stall protection active/)
    expect(helpersMock.client.setPower).not.toHaveBeenCalled()
    // A rejected command must not suspend autopilot.
    expect(automationMock.registerManualOverride).not.toHaveBeenCalled()
  })

  it('blocks a power-on queued behind a held side lock when the trip lands while queued', async () => {
    let tripped = false
    pumpStallMock.shouldBlock.mockImplementation(() => tripped)
    let release: () => void = () => {}
    const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()

    dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])
    const pending = caller.setPower({ side: 'left', powered: true, temperature: 72 })
    const assertion = expect(pending).rejects.toThrow(/Pump stall protection active/)
    // Let the mutation pass its entry check and queue on the held lock
    // while the guard is still healthy — the flip below happens strictly
    // after, so only an in-lock recheck can observe it.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    expect(pumpStallMock.shouldBlock).toHaveBeenCalled()
    tripped = true
    release()
    await holder
    await assertion
    expect(helpersMock.client.setPower).not.toHaveBeenCalled()
    expect(automationMock.registerManualOverride).not.toHaveBeenCalled()
  })

  it('allows powering off even when pump stall guard is active', async () => {
    pumpStallMock.shouldBlock.mockReturnValueOnce(true)
    dbState.rowsQueue.push([{ isPowered: true, poweredOnAt: new Date() }])
    await caller.setPower({ side: 'left', powered: false })
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', false, undefined)
  })

  it('swallows DB sync errors but still completes the hardware call', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // First select() throws — DB sync block fails, but withHardwareClient already
    // ran setPower before that point so the result still succeeds.
    dbMock.select.mockImplementationOnce(() => {
      throw new Error('db down')
    })
    const result = await caller.setPower({ side: 'left', powered: true, temperature: 72 })
    expect(result).toEqual({ success: true })
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', true, 72)
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to sync power state to DB'),
      expect.any(Error),
    )
    errSpy.mockRestore()
  })
})

describe('device.setAlarm / clearAlarm / snoozeAlarm', () => {
  it('setAlarm passes config to hardware and broadcasts vibrating=true', async () => {
    await caller.setAlarm({
      side: 'left',
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 60,
    })

    expect(snoozeMock.cancelSnooze).toHaveBeenCalledWith('left')
    expect(helpersMock.client.setAlarm).toHaveBeenCalledWith('left', {
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 60,
    })
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', { isAlarmVibrating: true })
    expect(dbChain('update').set).toHaveBeenCalledWith({
      isAlarmVibrating: true,
      lastUpdated: expect.any(Date),
    })
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to set alarm')
  })

  it('clearAlarm hits hardware and broadcasts vibrating=false', async () => {
    await caller.clearAlarm({ side: 'right' })
    expect(helpersMock.client.clearAlarm).toHaveBeenCalledWith('right')
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('right', { isAlarmVibrating: false })
    expect(dbChain('update').set).toHaveBeenCalledWith({
      isAlarmVibrating: false,
      lastUpdated: expect.any(Date),
    })
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to clear alarm')
  })

  it('snoozeAlarm clears alarm + invokes snoozeManager and returns timestamp', async () => {
    const snoozeUntil = new Date(1700000000000)
    snoozeMock.snoozeAlarm.mockReturnValue(snoozeUntil)

    const result = await caller.snoozeAlarm({ side: 'left', duration: 300 })
    expect(helpersMock.client.clearAlarm).toHaveBeenCalledWith('left')
    expect(snoozeMock.snoozeAlarm).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.snoozeUntil).toBe(Math.floor(snoozeUntil.getTime() / 1000))
    expect(snoozeMock.snoozeAlarm).toHaveBeenCalledWith('left', 300, {
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 120,
    })
    expect(dbChain('update').set).toHaveBeenCalledWith({
      isAlarmVibrating: false,
      lastUpdated: expect.any(Date),
    })
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to snooze alarm')
  })
})

describe('device.startPriming / dismissPrimeNotification', () => {
  it('startPriming hits hardware', async () => {
    const result = await caller.startPriming({})
    expect(helpersMock.client.startPriming).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
    expect(helpersMock.withHardwareClient.mock.calls[0]?.[1]).toBe('Failed to start priming')
  })

  it('dismissPrimeNotification calls the helper', async () => {
    const result = await caller.dismissPrimeNotification({})
    expect(primeMock.dismissPrimeNotification).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
  })
})

describe('device.execute (raw command)', () => {
  it('maps an allowlisted name to its opcode and returns disclaimer', async () => {
    sharedClientMock.sendRaw.mockResolvedValue('{ "ok": true }')

    const result = await caller.execute({ command: 'DEVICE_STATUS' })
    expect(sharedClientMock.sendRaw).toHaveBeenCalledWith('14', undefined)
    expect(result.command).toBe('DEVICE_STATUS')
    expect(result.opcode).toBe('14')
    expect(result.args).toBeNull()
    expect(result.response).toBe('{ "ok": true }')
    expect(result.disclaimer).toContain('Raw command execution')
  })

  it('passes a raw numeric opcode through verbatim', async () => {
    sharedClientMock.sendRaw.mockResolvedValue('ok')

    const result = await caller.execute({ command: '99', args: 'foo' })
    expect(sharedClientMock.sendRaw).toHaveBeenCalledWith('99', 'foo')
    expect(result.command).toBe('99')
    expect(result.opcode).toBe('99')
    expect(result.args).toBe('foo')
  })

  it('rejects non-numeric, non-allowlisted commands', async () => {
    await expect(caller.execute({ command: 'BOGUS' })).rejects.toThrow()
  })

  it.each(['x99', '99x', '1.5', '-1', ''])('rejects malformed numeric opcode %j', async (command) => {
    await expect(caller.execute({ command })).rejects.toThrow()
    expect(sharedClientMock.sendRaw).not.toHaveBeenCalled()
  })

  it('wraps transport errors as INTERNAL_SERVER_ERROR', async () => {
    sharedClientMock.sendRaw.mockRejectedValue(new Error('socket dead'))
    await expect(caller.execute({ command: 'DEVICE_STATUS' })).rejects.toThrow(/Failed to execute raw command: socket dead/)
  })

  it('uses Unknown error for a non-Error raw transport rejection', async () => {
    sharedClientMock.sendRaw.mockRejectedValue({ disconnected: true })
    await expect(caller.execute({ command: '14' })).rejects.toThrow('Failed to execute raw command: Unknown error')
  })

  it.each([
    ['TEMP_LEVEL_LEFT', 'left'],
    ['TEMP_LEVEL_RIGHT', 'right'],
    ['LEFT_TEMP_DURATION', 'left'],
    ['RIGHT_TEMP_DURATION', 'right'],
  ] as const)('blocks energizing %s when the %s guard is tripped', async (command, side) => {
    pumpStallMock.shouldBlock.mockImplementation(s => s === side)
    await expect(caller.execute({ command, args: '50' })).rejects.toThrow(/Pump stall protection active/)
    expect(sharedClientMock.sendRaw).not.toHaveBeenCalled()
  })

  it('blocks the numeric alias of an energizing opcode', async () => {
    pumpStallMock.shouldBlock.mockImplementation(s => s === 'left')
    await expect(caller.execute({ command: '11', args: '50' })).rejects.toThrow(/Pump stall protection active/)
    expect(sharedClientMock.sendRaw).not.toHaveBeenCalled()
  })

  it('blocks SET_TEMP when either side is tripped — legacy arg format claims no exemption', async () => {
    pumpStallMock.shouldBlock.mockImplementation(s => s === 'right')
    await expect(caller.execute({ command: 'SET_TEMP', args: '0' })).rejects.toThrow(/Pump stall protection active/)
    expect(sharedClientMock.sendRaw).not.toHaveBeenCalled()
  })

  it('lets a level-0 write through on a tripped side — powering off is never blocked', async () => {
    pumpStallMock.shouldBlock.mockReturnValue(true)
    sharedClientMock.sendRaw.mockResolvedValue('ok')
    await caller.execute({ command: 'TEMP_LEVEL_LEFT', args: '0' })
    expect(sharedClientMock.sendRaw).toHaveBeenCalledWith('11', '0')
  })

  it('leaves non-energizing and unknown commands unguarded while tripped', async () => {
    pumpStallMock.shouldBlock.mockReturnValue(true)
    sharedClientMock.sendRaw.mockResolvedValue('ok')
    await caller.execute({ command: 'DEVICE_STATUS' })
    await caller.execute({ command: 'ALARM_LEFT', args: '50,double,30,0' })
    await caller.execute({ command: '99', args: 'probe' })
    expect(sharedClientMock.sendRaw).toHaveBeenCalledTimes(3)
  })

  it('re-checks the guard inside the side lock before an energizing raw write', async () => {
    // Pre-flight check passes; the trip lands while the command queues.
    pumpStallMock.shouldBlock.mockReturnValueOnce(false).mockReturnValue(true)
    await expect(caller.execute({ command: 'TEMP_LEVEL_LEFT', args: '50' })).rejects.toThrow(/Pump stall protection active/)
    expect(sharedClientMock.sendRaw).not.toHaveBeenCalled()
  })

  it('queues an energizing raw write behind a held side lock', async () => {
    let releaseLeft!: () => void
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      releaseLeft = resolve
    }))
    try {
      sharedClientMock.sendRaw.mockResolvedValue('ok')
      const pending = caller.execute({ command: 'TEMP_LEVEL_LEFT', args: '50' })
      await Promise.resolve()
      expect(sharedClientMock.sendRaw).not.toHaveBeenCalled()

      releaseLeft()
      await holder
      await pending
      expect(sharedClientMock.sendRaw).toHaveBeenCalledWith('11', '50')
    }
    finally {
      releaseLeft()
      await holder.catch(() => {})
    }
  })
})

describe('device best-effort DB sync swallows errors', () => {
  beforeEach(() => {
    // Make `db.update(...)...` chain reject so the catch path fires.
    const failingChain = () => {
      const chain: Record<string, unknown> = {}
      chain.then = (_resolve: unknown, reject: (reason: unknown) => unknown) =>
        Promise.reject(new Error('db dead')).catch(reject)
      chain.where = vi.fn(() => chain)
      chain.set = vi.fn(() => chain)
      return chain
    }
    dbMock.update.mockImplementation(failingChain)
  })

  it('setAlarm logs but still broadcasts when the DB sync fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await caller.setAlarm({
      side: 'left', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 120,
    })
    expect(result).toEqual({ success: true })
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', { isAlarmVibrating: true })
    expect(errSpy).toHaveBeenCalledWith('Failed to sync alarm state to DB:', expect.any(Error))
    errSpy.mockRestore()
  })

  it('clearAlarm logs but still broadcasts when the DB sync fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await caller.clearAlarm({ side: 'right' })
    expect(result).toEqual({ success: true })
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('right', { isAlarmVibrating: false })
    expect(errSpy).toHaveBeenCalledWith('Failed to sync alarm clear state to DB:', expect.any(Error))
    errSpy.mockRestore()
  })

  it('snoozeAlarm logs but still broadcasts when the DB sync fails', async () => {
    snoozeMock.snoozeAlarm.mockReturnValue(new Date(1700000000000))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await caller.snoozeAlarm({
      side: 'left', duration: 300, vibrationIntensity: 50, vibrationPattern: 'rise', alarmDuration: 120,
    })
    expect(result.success).toBe(true)
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', { isAlarmVibrating: false })
    expect(errSpy).toHaveBeenCalledWith('Failed to sync snooze state to DB:', expect.any(Error))
    errSpy.mockRestore()
  })
})
