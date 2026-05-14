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
    markIdentityPaired: vi.fn(),
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
  markIdentityPaired: m.markIdentityPaired,
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
    // The load-bearing order is destroy() → clearPairings. hap-nodejs writes
    // to AccessoryInfo during shutdown; deleting the file mid-teardown
    // would race that write. clearPairings/regenerateIdentity order is
    // file-safe (oldUsername is captured upfront), so we don't pin it.
    if (!m.bridgeInstance) throw new Error('bridge instance missing')
    const destroyCall = m.bridgeInstance.destroy.mock.invocationCallOrder[0]
    const clearCall = m.clearPairings.mock.invocationCallOrder[0]
    expect(destroyCall).toBeLessThan(clearCall)
  })

  it('unpairAll without a prior startBridge falls back to loadOrCreateIdentity for the username', async () => {
    const { unpairAll } = await import('../bridge')
    // No startBridge → in-memory identity singleton is unset; the `??`
    // fallback must read identity.json via loadOrCreateIdentity to know
    // which AccessoryInfo.<MAC>.json to delete.
    m.regenerateIdentity.mockReturnValueOnce({
      username: 'NN:NN:NN:NN:NN:NN',
      pincode: '999-99-999',
      setupId: 'YYYY',
    })
    await unpairAll()
    expect(m.loadOrCreateIdentity).toHaveBeenCalled()
    expect(m.clearPairings).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF')
  })

  it('unpairAll aborts rotation when stopBridge fails to clear the singleton', async () => {
    const { startBridge, unpairAll, getStatus } = await import('../bridge')
    await startBridge(fakeMonitor)
    if (m.bridgeInstance) {
      m.bridgeInstance.destroy = vi.fn().mockRejectedValue(new Error('destroy failed'))
    }
    // Identity must stay on the old MAC — rotating while a live bridge
    // still answers on the old MAC would desync getStatus() from the
    // running HAP server.
    await expect(unpairAll()).rejects.toThrow(/bridge teardown incomplete/)
    expect(m.clearPairings).not.toHaveBeenCalled()
    expect(m.regenerateIdentity).not.toHaveBeenCalled()
    expect(getStatus().username).toBe('AA:BB:CC:DD:EE:FF')
  })

  it('stopBridge swallows stopper exceptions with a warning', async () => {
    const { startBridge, stopBridge, getStatus } = await import('../bridge')
    // Make one stopper explode; stopBridge must keep going and still tear down the bridge.
    m.thermostatStop.mockImplementationOnce((): never => {
      throw new Error('stopper kaboom')
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await startBridge(fakeMonitor)
    await stopBridge()
    expect(warnSpy).toHaveBeenCalledWith(
      '[homekit] stopper failed:',
      expect.stringMatching(/stopper kaboom/),
    )
    expect(getStatus().running).toBe(false)
    warnSpy.mockRestore()
  })

  it('stopBridge warns when unpublish() throws but destroy() still completes', async () => {
    const { startBridge, stopBridge, getStatus } = await import('../bridge')
    await startBridge(fakeMonitor)
    if (m.bridgeInstance) {
      m.bridgeInstance.unpublish = vi.fn().mockRejectedValue(new Error('unpub boom'))
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await stopBridge()
    expect(warnSpy).toHaveBeenCalledWith(
      '[homekit] unpublish failed:',
      expect.stringMatching(/unpub boom/),
    )
    expect(getStatus().running).toBe(false)
    warnSpy.mockRestore()
  })

  it('stopBridge clears setupURI even when no bridge was ever published', async () => {
    const { stopBridge, getStatus } = await import('../bridge')
    await stopBridge()
    expect(getStatus().setupURI).toBeNull()
    expect(getStatus().running).toBe(false)
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

  it('startBridge rotates identity when prior identity was paired but pairedClients is now empty', async () => {
    const { startBridge, getStatus } = await import('../bridge')
    m.loadOrCreateIdentity.mockReturnValueOnce({
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '123-45-678',
      setupId: 'XXXX',
      derivedFrom: 'test',
      wasPaired: true,
    })
    m.readPairedControllers.mockReturnValue([])
    m.regenerateIdentity.mockReturnValueOnce({
      username: 'NN:NN:NN:NN:NN:NN',
      pincode: '999-99-999',
      setupId: 'YYYY',
      rotation: 1,
    })
    await startBridge(fakeMonitor)
    expect(m.clearPairings).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF')
    expect(m.regenerateIdentity).toHaveBeenCalledTimes(1)
    expect(getStatus().username).toBe('NN:NN:NN:NN:NN:NN')
    expect(getStatus().pincode).toBe('999-99-999')
  })

  it('startBridge does NOT rotate when identity was never paired (fresh install)', async () => {
    const { startBridge, getStatus } = await import('../bridge')
    // loadOrCreateIdentity default returns no wasPaired; pairedClients empty.
    await startBridge(fakeMonitor)
    expect(m.clearPairings).not.toHaveBeenCalled()
    expect(m.regenerateIdentity).not.toHaveBeenCalled()
    expect(getStatus().username).toBe('AA:BB:CC:DD:EE:FF')
  })

  it('startBridge does NOT rotate when pairedClients is non-empty', async () => {
    const { startBridge, getStatus } = await import('../bridge')
    m.loadOrCreateIdentity.mockReturnValueOnce({
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '123-45-678',
      setupId: 'XXXX',
      derivedFrom: 'test',
      wasPaired: true,
    })
    m.readPairedControllers.mockReturnValue(['controller-1'])
    await startBridge(fakeMonitor)
    expect(m.clearPairings).not.toHaveBeenCalled()
    expect(m.regenerateIdentity).not.toHaveBeenCalled()
    expect(getStatus().username).toBe('AA:BB:CC:DD:EE:FF')
  })

  it('startBridge eagerly marks wasPaired when booting into an already-paired state', async () => {
    const { startBridge } = await import('../bridge')
    // wasPaired absent (e.g. a paired bridge restarted before the 30s
    // poll ever fired); pairedClients non-empty.
    m.readPairedControllers.mockReturnValue(['controller-1'])
    await startBridge(fakeMonitor)
    expect(m.markIdentityPaired).toHaveBeenCalledTimes(1)
    expect(m.regenerateIdentity).not.toHaveBeenCalled()
  })
})
