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
  const withHardwareClient = vi.fn(async (cb: (c: typeof client) => Promise<unknown>) => cb(client))
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

vi.mock('@/src/server/helpers', () => ({ withHardwareClient: helpersMock.withHardwareClient }))
vi.mock('@/src/hardware/primeNotification', () => primeMock)
vi.mock('@/src/hardware/snoozeManager', () => snoozeMock)
vi.mock('@/src/streaming/broadcastMutationStatus', () => broadcastMock)
vi.mock('@/src/hardware/dacTransport', () => transportMock)
vi.mock('@/src/hardware/sharedClient', () => ({ getSharedHardwareClient: sharedClientMock.getSharedHardwareClient }))
vi.mock('@/src/hardware/deviceStateSync', () => stateSyncMock)
vi.mock('@/src/db', () => ({
  db: dbMock,
  biometricsDb: {},
}))

const { deviceRouter } = await import('@/src/server/routers/device')
const caller = deviceRouter.createCaller({})

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
  dbState.rowsQueue.length = 0
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  dbMock.insert.mockClear()
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
})

describe('device.setTemperature', () => {
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
    }
    finally {
      vi.useRealTimers()
    }
  })
})

describe('device.setPower', () => {
  it('powers on with the provided temperature, broadcasts, syncs DB', async () => {
    dbState.rowsQueue.push([{ isPowered: false, poweredOnAt: null }])

    const result = await caller.setPower({ side: 'left', powered: true, temperature: 72 })
    expect(result).toEqual({ success: true })
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', true, 72)
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', expect.objectContaining({
      targetTemperature: 72,
    }))
  })

  it('powers off and broadcasts targetLevel: 0', async () => {
    dbState.rowsQueue.push([{ isPowered: true, poweredOnAt: new Date() }])

    await caller.setPower({ side: 'left', powered: false })
    expect(helpersMock.client.setPower).toHaveBeenCalledWith('left', false, undefined)
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
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
  })

  it('clearAlarm hits hardware and broadcasts vibrating=false', async () => {
    await caller.clearAlarm({ side: 'right' })
    expect(helpersMock.client.clearAlarm).toHaveBeenCalledWith('right')
    expect(broadcastMock.broadcastMutationStatus).toHaveBeenCalledWith('right', { isAlarmVibrating: false })
  })

  it('snoozeAlarm clears alarm + invokes snoozeManager and returns timestamp', async () => {
    const snoozeUntil = new Date(1700000000000)
    snoozeMock.snoozeAlarm.mockReturnValue(snoozeUntil)

    const result = await caller.snoozeAlarm({ side: 'left', duration: 300 })
    expect(helpersMock.client.clearAlarm).toHaveBeenCalledWith('left')
    expect(snoozeMock.snoozeAlarm).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(true)
    expect(result.snoozeUntil).toBe(Math.floor(snoozeUntil.getTime() / 1000))
  })
})

describe('device.startPriming / dismissPrimeNotification', () => {
  it('startPriming hits hardware', async () => {
    const result = await caller.startPriming({})
    expect(helpersMock.client.startPriming).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ success: true })
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

  it('wraps transport errors as INTERNAL_SERVER_ERROR', async () => {
    sharedClientMock.sendRaw.mockRejectedValue(new Error('socket dead'))
    await expect(caller.execute({ command: 'DEVICE_STATUS' })).rejects.toThrow(/Failed to execute raw command: socket dead/)
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
