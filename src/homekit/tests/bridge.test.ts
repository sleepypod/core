import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HapNodeJs from 'hap-nodejs'

const m = vi.hoisted(() => {
  const fakeAccessory = (name: string) => ({
    name,
    addService: vi.fn(),
    getService: vi.fn().mockReturnValue({
      setCharacteristic: vi.fn().mockReturnThis(),
    }),
    addBridgedAccessory: vi.fn(),
    publish: vi.fn().mockResolvedValue(undefined),
    unpublish: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    setupURI: vi.fn().mockReturnValue('X-HM://test'),
  })

  return {
    bridgeInstance: null as ReturnType<typeof fakeAccessory> | null,
    BridgeCtor: vi.fn(function BridgeCtor(this: unknown, name: string) {
      const inst = fakeAccessory(name)
      m.bridgeInstance = inst
      return inst
    }),
    AccessoryCtor: vi.fn(function AccessoryCtor(this: unknown, name: string) {
      return fakeAccessory(name)
    }),
    thermostatStop: vi.fn(),
    occupancyStop: vi.fn(),
    snoozeStop: vi.fn(),
    powerStop: vi.fn(),
    primeStop: vi.fn(),
    buildThermostatService: vi.fn(),
    buildOccupancySensor: vi.fn(),
    buildSnoozeSwitch: vi.fn(),
    buildPowerSwitch: vi.fn(),
    buildPrimeSwitch: vi.fn(),
    initHapStorage: vi.fn(),
    loadOrCreateIdentity: vi.fn(),
    readPairedControllers: vi.fn(),
    regenerateIdentity: vi.fn(),
    clearPairings: vi.fn(),
  }
})

vi.mock('hap-nodejs', async () => {
  const actual = await vi.importActual<typeof HapNodeJs>('hap-nodejs')
  return {
    ...actual,
    Bridge: m.BridgeCtor,
    Accessory: m.AccessoryCtor,
  }
})

vi.mock('../accessories/thermostat', () => ({
  buildThermostatService: m.buildThermostatService,
}))
vi.mock('../accessories/occupancySensor', () => ({
  buildOccupancySensor: m.buildOccupancySensor,
}))
vi.mock('../accessories/snoozeSwitch', () => ({
  buildSnoozeSwitch: m.buildSnoozeSwitch,
}))
vi.mock('../accessories/powerSwitch', () => ({
  buildPowerSwitch: m.buildPowerSwitch,
}))
vi.mock('../accessories/primeSwitch', () => ({
  buildPrimeSwitch: m.buildPrimeSwitch,
}))
vi.mock('../storage', () => ({
  initHapStorage: m.initHapStorage,
  loadOrCreateIdentity: m.loadOrCreateIdentity,
  readPairedControllers: m.readPairedControllers,
  regenerateIdentity: m.regenerateIdentity,
  clearPairings: m.clearPairings,
}))

import type { DacMonitor } from '@/src/hardware/dacMonitor'

const fakeService = { name: 'fake' } as never
const fakeMonitor = { on: vi.fn(), off: vi.fn(), getLastStatus: vi.fn() } as unknown as DacMonitor

describe('homekit bridge', () => {
  beforeEach(async () => {
    vi.resetModules()
    const g = globalThis as Record<string, unknown>
    delete g.__sp_homekit_bridge__
    delete g.__sp_homekit_stoppers__
    delete g.__sp_homekit_identity__
    delete g.__sp_homekit_setupURI__

    m.bridgeInstance = null
    m.BridgeCtor.mockClear()
    m.AccessoryCtor.mockClear()
    m.thermostatStop.mockClear()
    m.occupancyStop.mockClear()
    m.snoozeStop.mockClear()
    m.powerStop.mockClear()
    m.primeStop.mockClear()

    m.buildThermostatService.mockImplementation(() => ({ service: fakeService, stop: m.thermostatStop }))
    m.buildOccupancySensor.mockImplementation(() => ({ service: fakeService, stop: m.occupancyStop }))
    m.buildSnoozeSwitch.mockImplementation(() => ({ service: fakeService, stop: m.snoozeStop }))
    m.buildPowerSwitch.mockImplementation(() => ({ service: fakeService, stop: m.powerStop }))
    m.buildPrimeSwitch.mockImplementation(() => ({ service: fakeService, stop: m.primeStop }))

    m.loadOrCreateIdentity.mockReturnValue({
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '123-45-678',
      setupId: 'XXXX',
      derivedFrom: 'test',
    })
    m.readPairedControllers.mockReturnValue([])
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('startBridge wires Thermostat + Occupancy + Snooze + Power per side, plus Prime', async () => {
    const { startBridge } = await import('../bridge')
    await startBridge(fakeMonitor)

    // 2 sides × 4 per-side accessories + 1 prime = 9 bridged accessories
    expect(m.bridgeInstance?.addBridgedAccessory).toHaveBeenCalledTimes(9)

    // Builders called with the expected sides.
    expect(m.buildThermostatService).toHaveBeenCalledWith('left', fakeMonitor)
    expect(m.buildThermostatService).toHaveBeenCalledWith('right', fakeMonitor)
    expect(m.buildPowerSwitch).toHaveBeenCalledWith('left', fakeMonitor)
    expect(m.buildPowerSwitch).toHaveBeenCalledWith('right', fakeMonitor)
    expect(m.buildOccupancySensor).toHaveBeenCalledWith('left')
    expect(m.buildOccupancySensor).toHaveBeenCalledWith('right')
    expect(m.buildSnoozeSwitch).toHaveBeenCalledWith('left')
    expect(m.buildSnoozeSwitch).toHaveBeenCalledWith('right')
    expect(m.buildPrimeSwitch).toHaveBeenCalledTimes(1)
  })

  it('startBridge constructs the bridge with lowercase "sleepypod" name', async () => {
    const { startBridge } = await import('../bridge')
    await startBridge(fakeMonitor)
    expect(m.BridgeCtor).toHaveBeenCalledWith('sleepypod', expect.any(String))
  })

  it('startBridge is idempotent when a bridge is already published', async () => {
    const { startBridge } = await import('../bridge')
    await startBridge(fakeMonitor)
    m.BridgeCtor.mockClear()
    await startBridge(fakeMonitor)
    expect(m.BridgeCtor).not.toHaveBeenCalled()
  })

  it('publish failure tears down all just-built accessories before rethrowing', async () => {
    const { startBridge } = await import('../bridge')
    m.BridgeCtor.mockImplementationOnce(function BridgeFail(this: unknown, name: string) {
      const inst = {
        name,
        addService: vi.fn(),
        getService: vi.fn().mockReturnValue({ setCharacteristic: vi.fn().mockReturnThis() }),
        addBridgedAccessory: vi.fn(),
        publish: vi.fn().mockRejectedValue(new Error('port in use')),
        unpublish: vi.fn(),
        destroy: vi.fn(),
        setupURI: vi.fn(),
      }
      m.bridgeInstance = inst as never
      return inst
    })

    await expect(startBridge(fakeMonitor)).rejects.toThrow('port in use')
    expect(m.thermostatStop).toHaveBeenCalledTimes(2)
    expect(m.occupancyStop).toHaveBeenCalledTimes(2)
    expect(m.snoozeStop).toHaveBeenCalledTimes(2)
    expect(m.powerStop).toHaveBeenCalledTimes(2)
    expect(m.primeStop).toHaveBeenCalledTimes(1)
  })

  it('stopBridge fires every stopper and clears the singleton', async () => {
    const { startBridge, stopBridge, getStatus } = await import('../bridge')
    await startBridge(fakeMonitor)
    expect(getStatus().running).toBe(true)

    await stopBridge()
    expect(m.thermostatStop).toHaveBeenCalledTimes(2)
    expect(m.powerStop).toHaveBeenCalledTimes(2)
    expect(m.primeStop).toHaveBeenCalledTimes(1)
    expect(getStatus().running).toBe(false)
  })

  it('stopBridge keeps the singleton live when destroy() throws', async () => {
    const { startBridge, stopBridge, getStatus } = await import('../bridge')
    await startBridge(fakeMonitor)
    if (m.bridgeInstance) {
      m.bridgeInstance.destroy = vi.fn().mockRejectedValue(new Error('destroy failed'))
    }
    await stopBridge()
    expect(getStatus().running).toBe(true)
  })

  it('unpairAll stops the bridge, clears pairings, and rotates identity', async () => {
    const { startBridge, unpairAll, getStatus } = await import('../bridge')
    await startBridge(fakeMonitor)
    m.regenerateIdentity.mockReturnValueOnce({
      username: 'NN:NN:NN:NN:NN:NN',
      pincode: '999-99-999',
      setupId: 'YYYY',
    })
    await unpairAll()
    expect(m.clearPairings).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF')
    expect(m.regenerateIdentity).toHaveBeenCalledTimes(1)
    expect(getStatus().username).toBe('NN:NN:NN:NN:NN:NN')
    // clearPairings must run BEFORE the rotation so the stale
    // AccessoryInfo.<old-MAC>.json is removed; otherwise it lingers as
    // an orphan whenever the rotation produces a different filename.
    expect(m.clearPairings.mock.invocationCallOrder[0])
      .toBeLessThan(m.regenerateIdentity.mock.invocationCallOrder[0])
  })

  it('regenerate stops the bridge and replaces identity', async () => {
    const { startBridge, regenerate, getStatus } = await import('../bridge')
    await startBridge(fakeMonitor)
    m.regenerateIdentity.mockReturnValueOnce({
      username: 'NN:NN:NN:NN:NN:NN',
      pincode: '999-99-999',
      setupId: 'YYYY',
    })
    const id = await regenerate()
    expect(id?.username).toBe('NN:NN:NN:NN:NN:NN')
    expect(getStatus().running).toBe(false)
    expect(getStatus().username).toBe('NN:NN:NN:NN:NN:NN')
  })
})
