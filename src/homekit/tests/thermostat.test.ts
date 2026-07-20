import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const setTemperature = vi.fn().mockResolvedValue(undefined)
const setPower = vi.fn().mockResolvedValue(undefined)
const registerManualOverride = vi.fn()

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ setTemperature, setPower }),
}))
vi.mock('@/src/automation', () => ({
  getAutomationEngineIfRunning: () => ({ registerManualOverride }),
}))

import { buildThermostatService } from '../accessories/thermostat'
import { __resetSideController } from '../accessories/sideController'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus } from '@/src/hardware/types'

const status: DeviceStatus = {
  leftSide: { currentTemperature: 75, targetTemperature: 70, currentLevel: -20, targetLevel: -45, heatingDuration: 0 },
  rightSide: { currentTemperature: 80, targetTemperature: 80, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
  waterLevel: 'ok',
  isPriming: false,
  podVersion: 'I00' as never,
  sensorLabel: 'pod4',
}

const fakeMonitor: Pick<DacMonitor, 'on' | 'off' | 'getLastStatus'> = {
  on: vi.fn().mockReturnThis() as never,
  off: vi.fn().mockReturnThis() as never,
  getLastStatus: () => status,
}

const f2c = (f: number) => ((f - 32) * 5) / 9

describe('thermostat accessory', () => {
  beforeEach(() => {
    __resetSideController()
    setTemperature.mockClear()
    setPower.mockClear()
    registerManualOverride.mockClear()
  })

  it.each(['left', 'right'] as const)('uses stable metadata for the %s side', (side) => {
    const { service, stop } = buildThermostatService(side, fakeMonitor as DacMonitor)
    expect(service.displayName).toBe(`Bed ${side}`)
    expect(service.subtype).toBe(side)
    stop()
  })

  it('sets exact temperature bounds, mode values, and read-only display-unit permissions', () => {
    const { service, stop } = buildThermostatService('left', fakeMonitor as DacMonitor)
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
    const { service } = buildThermostatService('left', fakeMonitor as DacMonitor)
    const value = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    expect(typeof value).toBe('number')
    // Tolerance covers hap-nodejs's minStep rounding (0.5°C).
    expect(Math.abs((value as number) - f2c(75))).toBeLessThan(0.5)
  })

  it('reports target temperature in Celsius via onGet', async () => {
    const { service } = buildThermostatService('left', fakeMonitor as DacMonitor)
    const value = await service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()
    expect(Math.abs((value as number) - f2c(70))).toBeLessThan(0.5)
  })

  it('forwards TargetTemperature onSet to setTemperature with clamped F', async () => {
    setTemperature.mockClear()
    const { service } = buildThermostatService('left', fakeMonitor as DacMonitor)
    // Way above range: 100°C → clamped to MAX_TEMP (110°F).
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(100)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeLessThanOrEqual(110)
    expect(f).toBeGreaterThanOrEqual(55)
  })

  it('clamps below-range TargetTemperature up to MIN_TEMP', async () => {
    setTemperature.mockClear()
    const { service } = buildThermostatService('left', fakeMonitor as DacMonitor)
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(-10)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeGreaterThanOrEqual(55)
    expect(f).toBeLessThanOrEqual(110)
  })

  it('TargetHeatingCoolingState onGet returns AUTO (3) when powered, OFF (0) otherwise', async () => {
    const { service: leftSvc } = buildThermostatService('left', fakeMonitor as DacMonitor)
    expect(await leftSvc.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleGetRequest()).toBe(3)

    const { service: rightSvc } = buildThermostatService('right', fakeMonitor as DacMonitor)
    expect(await rightSvc.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleGetRequest()).toBe(0)
  })

  it('TargetHeatingCoolingState onSet routes to setPower and preserves the last target on power-on', async () => {
    const { service } = buildThermostatService('right', fakeMonitor as DacMonitor)
    // handleSetRequest properly awaits onSet's full chain; setValue's await
    // resolves on `this` and skips microtasks scheduled inside the chain.
    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(3)
    // Right fixture targetTemperature is 80°F — must pass through so the
    // hardware client doesn't silently fall back to its 75°F default.
    expect(setPower).toHaveBeenCalledWith('right', true, 80)

    setPower.mockClear()
    await service.getCharacteristic(Characteristic.TargetHeatingCoolingState).handleSetRequest(0)
    expect(setPower).toHaveBeenCalledWith('right', false)
  })

  it('sends setTemperature for an in-range decrease — regression path HeaterCooler failed', async () => {
    setTemperature.mockClear()
    const { service } = buildThermostatService('left', fakeMonitor as DacMonitor)
    // Left fixture targetTemperature is 70°F; simulate dragging the slider
    // down to 65°F. Old HeaterCooler dual-threshold collapsed on decrease
    // and iOS rejected it as deadband-violating.
    await service.getCharacteristic(Characteristic.TargetTemperature).handleSetRequest(f2c(65))
    expect(setTemperature).toHaveBeenCalledTimes(1)
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeGreaterThan(64)
    expect(f).toBeLessThan(66)
  })

  it('CurrentHeatingCoolingState reflects targetLevel sign', async () => {
    // Heating: targetLevel > 0
    const heating: DeviceStatus = {
      ...status,
      leftSide: { currentTemperature: 70, targetTemperature: 90, currentLevel: 0, targetLevel: 50, heatingDuration: 0 },
    }
    const heatingMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => heating,
    }
    const { service: heatSvc } = buildThermostatService('left', heatingMonitor as DacMonitor)
    expect(await heatSvc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(1)

    // Cooling: targetLevel < 0
    const { service: coolSvc } = buildThermostatService('left', fakeMonitor as DacMonitor)
    expect(await coolSvc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(2)

    // Off: targetLevel === 0
    const { service: offSvc } = buildThermostatService('right', fakeMonitor as DacMonitor)
    expect(await offSvc.getCharacteristic(Characteristic.CurrentHeatingCoolingState).handleGetRequest()).toBe(0)
  })

  it('returns NEUTRAL_C when monitor has no status yet', async () => {
    const blank: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => null,
    }
    const { service } = buildThermostatService('left', blank as DacMonitor)
    const current = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    const target = await service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()
    // NEUTRAL_C = f2c(82.5) ≈ 28.06
    expect(current).toBeGreaterThan(27)
    expect(current).toBeLessThan(29)
    expect(target).toBeGreaterThan(27)
    expect(target).toBeLessThan(29)
  })

  it('maps a null side temperature to NEUTRAL_C even with a live status', async () => {
    // Distinct from the no-status case: status exists but the off side reports
    // null current/target temps (level 0). HomeKit needs a number, so each
    // maps to neutral rather than passing null through.
    const offNull: DeviceStatus = {
      ...status,
      leftSide: { ...status.leftSide, currentTemperature: null, targetTemperature: null },
    }
    const m: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => offNull,
    }
    const { service } = buildThermostatService('left', m as DacMonitor)
    const current = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    const target = await service.getCharacteristic(Characteristic.TargetTemperature).handleGetRequest()
    // NEUTRAL_C = f2c(82.5) ≈ 28.06
    expect(current).toBeGreaterThan(27)
    expect(current).toBeLessThan(29)
    expect(target).toBeGreaterThan(27)
    expect(target).toBeLessThan(29)
  })

  it('TemperatureDisplayUnits onGet reports Celsius (0)', async () => {
    const { service } = buildThermostatService('left', fakeMonitor as DacMonitor)
    expect(await service.getCharacteristic(Characteristic.TemperatureDisplayUnits).handleGetRequest()).toBe(0)
  })

  it('subscribed status:updated handler pushes characteristic updates', () => {
    let captured: ((s: DeviceStatus) => void) | null = null
    const onSpy = vi.fn((evt: string, fn: (s: DeviceStatus) => void) => {
      if (evt === 'status:updated') captured = fn
      return monitor as unknown as DacMonitor
    })
    const monitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: onSpy as never,
      getLastStatus: () => status,
    }
    const { service } = buildThermostatService('left', monitor as DacMonitor)
    expect(typeof captured).toBe('function')
    const updateSpy = vi.spyOn(service, 'updateCharacteristic')
    if (captured) (captured as (s: DeviceStatus) => void)(status)
    // Four updates: CurrentTemp, TargetTemp, TargetHeatingCoolingState, CurrentHeatingCoolingState
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('stop() unsubscribes the status listener', () => {
    const off = vi.fn()
    const onSpy = vi.fn().mockReturnThis()
    const monitor = {
      on: onSpy as never,
      off: off as never,
      getLastStatus: () => status,
    }
    const { stop } = buildThermostatService('left', monitor as unknown as DacMonitor)
    stop()
    expect(off).toHaveBeenCalledWith('status:updated', expect.any(Function))
  })
})
