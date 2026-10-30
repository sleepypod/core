import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const setTemperature = vi.fn().mockResolvedValue(undefined)
const setPower = vi.fn().mockResolvedValue(undefined)
const shouldBlock = vi.fn<() => boolean>().mockReturnValue(false)

// Test HomeKit's staging, serialization, and error mapping at the shared
// controller boundary. Controller/hardware integration has its own real-DB tests.
vi.mock('@/src/temperature/instance', () => ({
  getTemperatureController: () => ({
    setManualLocked: (side: 'left' | 'right', target: number, _hold?: number, _duration?: number, validate?: () => void) => {
      validate?.()
      return setTemperature(side, target)
    },
    powerOffLocked: (side: 'left' | 'right') => setPower(side, false),
  }),
}))
vi.mock('@/src/hardware/pumpStallGuard', () => ({
  shouldBlock: () => shouldBlock(),
}))
vi.mock('@/src/scheduler', () => ({
  getJobManager: async () => ({ releaseHeldPowerOff: () => {} }),
}))

import { buildThermostatService as createThermostatService } from '../accessories/thermostat'
import { __resetSideController } from '../accessories/sideController'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus } from '@/src/hardware/types'
import { fahrenheitToLevel } from '@/src/hardware/types'

const now = Date.parse('2026-10-25T12:00:00Z')
const built: ReturnType<typeof createThermostatService>[] = []
function buildThermostatService(...args: Parameters<typeof createThermostatService>) {
  const result = createThermostatService(...args)
  built.push(result)
  return result
}
afterEach(() => {
  built.splice(0).forEach(value => value.stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const status: DeviceStatus = {
  leftSide: { currentTemperature: 75, targetTemperature: 70, currentLevel: -20, targetLevel: -45, heatingDuration: 900 },
  rightSide: { currentTemperature: 80, targetTemperature: 80, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  waterLevel: 'ok',
  isPriming: false,
  podVersion: 'I00' as never,
  sensorLabel: 'pod4',
}

const fakeMonitor: Pick<DacMonitor, 'on' | 'off' | 'getLastStatus' | 'getFreshStatus' | 'getLastPollAt'> = {
  on: vi.fn().mockReturnThis() as never,
  off: vi.fn().mockReturnThis() as never,
  getLastStatus: () => status,
  getFreshStatus: () => status,
  getLastPollAt: () => now,
}

const f2c = (f: number) => ((f - 32) * 5) / 9

describe('thermostat accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(now)
    __resetSideController()
    setTemperature.mockClear()
    setPower.mockClear()
    shouldBlock.mockReset()
    shouldBlock.mockReturnValue(false)
  })

  it.each(['left', 'right'] as const)('uses stable metadata for the %s side', (side) => {
    const { service, stop } = buildThermostatService(side, fakeMonitor as unknown as DacMonitor)
    expect(service.displayName).toBe(`Bed ${side}`)
    expect(service.subtype).toBe(side)
    stop()
  })

  it('sets exact temperature bounds, mode values, and read-only display-unit permissions', () => {
    const { service, stop } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    const minC = f2c(55)
    const maxC = f2c(110)

    expect(service.getCharacteristic(Characteristic.CurrentTemperature).props).toMatchObject({
      minValue: minC,
      maxValue: maxC,
      minStep: 0.5,
    })
    expect(service.getCharacteristic(Characteristic.TargetTemperature).props).toMatchObject({
      minValue: minC,
      maxValue: maxC,
      minStep: 0.5,
    })
    expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).props.validValues).toEqual([0, 3])
    expect(service.getCharacteristic(Characteristic.TemperatureDisplayUnits).props.perms).toEqual(['pr', 'ev'])
    stop()
  })

  it('reports current temperature in Celsius via onGet', async () => {
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    const value = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    expect(typeof value).toBe('number')
    // Tolerance covers hap-nodejs's minStep rounding (0.5°C).
    expect(Math.abs((value as number) - f2c(75))).toBeLessThan(0.5)
  })

  it('reports target temperature in Celsius via onGet', async () => {
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    const value = await service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()
    expect(Math.abs((value as number) - f2c(70))).toBeLessThan(0.5)
  })

  it('reads the right side, not the left, when built for right', async () => {
    const { service } = buildThermostatService('right', fakeMonitor as unknown as DacMonitor)
    const current = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    const target = await service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()
    // Right fixture reads 80/80°F — the left fixture's 75/70°F must not leak through.
    expect(Math.abs((current as number) - f2c(80))).toBeLessThan(0.5)
    expect(Math.abs((target as number) - f2c(80))).toBeLessThan(0.5)
  })

  it('forwards TargetTemperature onSet to setTemperature with clamped F', async () => {
    setTemperature.mockClear()
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    // Way above range: 100°C → clamped to MAX_TEMP (110°F).
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(100)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeLessThanOrEqual(110)
    expect(f).toBeGreaterThanOrEqual(55)
  })

  it('clamps below-range TargetTemperature up to MIN_TEMP', async () => {
    setTemperature.mockClear()
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(-10)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeGreaterThanOrEqual(55)
    expect(f).toBeLessThanOrEqual(110)
  })

  it.each([28, 28.5])('rounds a %s°C target to whole °F so it never lands on the neutral level', async (c) => {
    // 28.0°C is 82.4°F, which fahrenheitToLevel maps to level 0: the firmware
    // treats that as off, and device_state then reads the side as off.
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(c)
    expect(setTemperature).toHaveBeenCalledTimes(1)
    const [, f] = setTemperature.mock.calls[0]
    expect(Number.isInteger(f)).toBe(true)
    expect(fahrenheitToLevel(f)).not.toBe(0)
  })

  it('TargetHeatingCoolingState onGet returns AUTO (3) when powered, OFF (0) otherwise', async () => {
    const { service: leftSvc } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    expect(await leftSvc.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleGetRequest()).toBe(3)

    const { service: rightSvc } = buildThermostatService('right', fakeMonitor as unknown as DacMonitor)
    expect(await rightSvc.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleGetRequest()).toBe(0)
  })

  it('TargetHeatingCoolingState onSet routes to setPower and preserves the last target on power-on', async () => {
    const { service } = buildThermostatService('right', fakeMonitor as unknown as DacMonitor)
    // handleSetRequest properly awaits onSet's full chain; setValue's await
    // resolves on `this` and skips microtasks scheduled inside the chain.
    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(3)
    // Right fixture targetTemperature is 80°F — must pass through so the
    // hardware client doesn't silently fall back to its 75°F default.
    expect(setTemperature).toHaveBeenCalledWith('right', 80)

    setPower.mockClear()
    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(0)
    expect(setPower).toHaveBeenCalledWith('right', false)
  })

  it('sends setTemperature for an in-range decrease — regression path HeaterCooler failed', async () => {
    setTemperature.mockClear()
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    // Left fixture targetTemperature is 70°F; simulate dragging the slider
    // down to 65°F. Old HeaterCooler dual-threshold collapsed on decrease
    // and iOS rejected it as deadband-violating.
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(f2c(65))
    expect(setTemperature).toHaveBeenCalledTimes(1)
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeGreaterThan(64)
    expect(f).toBeLessThan(66)
  })

  it('a guard-rejected TargetTemperature keeps HAP at oldValue but retains the requested intent for the next power-on', async () => {
    // Requested-intent contract (PR #670 review F1, decided 2026-07-22):
    // hap-nodejs assigns Characteristic.value only when onSet resolves, so a
    // gated rejection leaves the visible slider at its old value while the
    // staged cache advances. The staged value must survive the rejection and
    // apply on the next explicit power-on after the side is re-enabled.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const report = { ...status, leftSide: { ...status.leftSide, targetTemperature: 77 } }
    const { service } = buildThermostatService('left', { ...fakeMonitor, getFreshStatus: () => report } as unknown as DacMonitor)
    const target = service.getCharacteristic(Characteristic.TargetTemperature)
    // Seed the visible value the way a live bridge would (status push): 77°F.
    target.updateValue(f2c(77))

    shouldBlock.mockReturnValue(true)
    // Left fixture is powered (targetLevel -45), so the push is gated. At the
    // HAP boundary handleSetRequest rejects with the raw status number: -70412
    // (NOT_ALLOWED_IN_CURRENT_STATE), not a generic communication failure.
    await expect(target.handleSetRequest(f2c(95))).rejects.toBe(-70412)

    // Visible characteristic froze at oldValue (tolerance covers hap-nodejs's
    // minStep grid rounding); nothing reached hardware.
    expect(Math.abs((target.value as number) - f2c(77))).toBeLessThan(0.5)
    expect(setTemperature).not.toHaveBeenCalled()

    // Side re-enabled; an explicit power-on heats to the retained 95°F —
    // the requested intent, not the 77°F the slider visibly reverted to.
    shouldBlock.mockReturnValue(false)
    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(3)
    expect(setTemperature).toHaveBeenCalledWith('left', 95)
    warn.mockRestore()
  })

  it('CurrentHeatingCoolingState follows the reported current level independently of the requested level', async () => {
    // Heating: targetLevel > 0
    const heating: DeviceStatus = {
      ...status,
      leftSide: { currentTemperature: 70, targetTemperature: 90, currentLevel: 50, targetLevel: -50, heatingDuration: 0 },
    }
    const heatingMonitor: Pick<DacMonitor, 'on' | 'getLastStatus' | 'getFreshStatus' | 'getLastPollAt' | 'off'> = {
      on: vi.fn().mockReturnThis() as never,
      off: vi.fn().mockReturnThis() as never,
      getLastStatus: () => heating,
      getFreshStatus: () => heating,
      getLastPollAt: () => now,
    }
    const { service: heatSvc } = buildThermostatService('left', heatingMonitor as unknown as DacMonitor)
    expect(await heatSvc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(1)

    // Cooling: targetLevel < 0
    const { service: coolSvc } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    expect(await coolSvc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(2)

    // Off: targetLevel === 0
    const { service: offSvc } = buildThermostatService('right', fakeMonitor as unknown as DacMonitor)
    expect(await offSvc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(0)
  })

  it.each([null, NaN, Infinity, 54, 111])('reports unavailable temperatures for %s without inventing neutral', async (temperature) => {
    const missing = { ...status, leftSide: { ...status.leftSide, currentTemperature: temperature, targetTemperature: temperature } }
    const monitor = { ...fakeMonitor, getLastStatus: () => missing, getFreshStatus: () => missing }
    const { service } = buildThermostatService('left', monitor as unknown as DacMonitor)
    await expect(service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).rejects.toBe(-70402)
    await expect(service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()).rejects.toBe(-70402)
    expect(await service.getCharacteristic(Characteristic.StatusFault).handleGetRequest()).toBe(1)
  })

  it('reports unavailable modes and temperatures before the first successful poll', async () => {
    const { service } = buildThermostatService('left', { ...fakeMonitor, getFreshStatus: () => null } as unknown as DacMonitor)
    for (const type of [Characteristic.CurrentTemperature, Characteristic.TargetTemperature,
      Characteristic.CurrentHeatingCoolingState, Characteristic.TargetHeatingCoolingState]) {
      await expect(service.getCharacteristic(type).handleGetRequest()).rejects.toBe(-70402)
    }
  })

  it('keeps an explicit staged target on an off side without claiming current temperature or powering on', async () => {
    const off = { ...status, leftSide: { ...status.leftSide, currentLevel: 0, targetLevel: 0, currentTemperature: null, targetTemperature: null } }
    const { service } = buildThermostatService('left', { ...fakeMonitor, getLastStatus: () => off, getFreshStatus: () => off } as unknown as DacMonitor)
    const target = service.getCharacteristic(Characteristic.TargetTemperature)
    await expect(target.handleGetRequest()).rejects.toBe(-70402)
    await target.handleSetRequest(f2c(75))
    expect(Math.abs(Number(await target.handleGetRequest()) - f2c(75))).toBeLessThan(0.5)
    await expect(service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).rejects.toBe(-70402)
    expect(await service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(0)
    expect(setTemperature).not.toHaveBeenCalled()
    expect(setPower).not.toHaveBeenCalled()
  })

  it('shows the staged target while OFF even when firmware retains an older non-null target', async () => {
    const off = { ...status, leftSide: { ...status.leftSide, targetLevel: 0, heatingDuration: 0, targetTemperature: 70 } }
    const { service } = buildThermostatService('left', { ...fakeMonitor, getFreshStatus: () => off } as unknown as DacMonitor)
    const target = service.getCharacteristic(Characteristic.TargetTemperature)
    await target.handleSetRequest(f2c(75))
    expect(Math.abs(Number(await target.handleGetRequest()) - f2c(75))).toBeLessThan(0.5)
    expect(setTemperature).not.toHaveBeenCalled()
    expect(await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleGetRequest()).toBe(0)
  })

  it('always allows an explicit power-off even when reports are unavailable', async () => {
    const { service } = buildThermostatService('left', { ...fakeMonitor, getFreshStatus: () => null } as unknown as DacMonitor)
    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(0)
    expect(setPower).toHaveBeenCalledWith('left', false)
    await expect(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).rejects.toBe(-70402)
  })

  it.each([null, NaN, Infinity, now + 1, now - 15000])('rejects an invalid source timestamp %s', async (at) => {
    const { service } = buildThermostatService('left', { ...fakeMonitor, getLastPollAt: () => at } as unknown as DacMonitor)
    await expect(service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).rejects.toBe(-70402)
  })

  it.each([NaN, Infinity, 101, -101, 1.5])('rejects invalid reported levels %s instead of inferring a mode', async (level) => {
    const invalid = { ...status, leftSide: { ...status.leftSide, currentLevel: level, targetLevel: level } }
    const { service } = buildThermostatService('left', { ...fakeMonitor, getFreshStatus: () => invalid } as unknown as DacMonitor)
    await expect(service.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).rejects.toBe(-70402)
    await expect(service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleGetRequest()).rejects.toBe(-70402)
    expect(typeof await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).toBe('number')
  })

  it('TemperatureDisplayUnits onGet reports Celsius (0)', async () => {
    const { service } = buildThermostatService('left', fakeMonitor as unknown as DacMonitor)
    expect(await service.getCharacteristic(Characteristic.TemperatureDisplayUnits).handleGetRequest()).toBe(0)
  })

  it('subscribed status:updated handler pushes characteristic updates', () => {
    let captured: ((s: DeviceStatus) => void) | null = null
    const onSpy = vi.fn((evt: string, fn: (s: DeviceStatus) => void) => {
      if (evt === 'status:updated') captured = fn
      return monitor as unknown as DacMonitor
    })
    const monitor: Pick<DacMonitor, 'on' | 'getLastStatus' | 'getFreshStatus' | 'getLastPollAt' | 'off'> = {
      on: onSpy as never,
      off: vi.fn().mockReturnThis() as never,
      getLastStatus: () => status,
      getFreshStatus: () => status,
      getLastPollAt: () => now,
    }
    const { service } = buildThermostatService('left', monitor as unknown as DacMonitor)
    expect(typeof captured).toBe('function')
    const updateSpy = vi.spyOn(service.getCharacteristic(Characteristic.CurrentTemperature), 'updateValue')
    if (captured) (captured as (s: DeviceStatus) => void)(status)
    expect(updateSpy).toHaveBeenCalledWith(f2c(75))
  })

  it('stop() unsubscribes the status listener', () => {
    const off = vi.fn()
    const onSpy = vi.fn().mockReturnThis()
    const monitor = {
      on: onSpy as never,
      off: off as never,
      getLastStatus: () => status,
      getFreshStatus: () => status,
      getLastPollAt: () => now,
    }
    const { stop } = buildThermostatService('left', monitor as unknown as DacMonitor)
    stop()
    expect(off).toHaveBeenCalledWith('status:updated', expect.any(Function))
  })
})
