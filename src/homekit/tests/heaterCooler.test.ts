import { describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const setTemperature = vi.fn().mockResolvedValue(undefined)
const setPower = vi.fn().mockResolvedValue(undefined)

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ setTemperature, setPower }),
}))

import { buildHeaterCoolerService } from '../accessories/heaterCooler'
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

const fakeMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
  on: vi.fn().mockReturnThis() as never,
  getLastStatus: () => status,
}

const f2c = (f: number) => ((f - 32) * 5) / 9

describe('heaterCooler accessory', () => {
  it('reports current temperature in Celsius via onGet', async () => {
    const { service } = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)
    const handler = service.getCharacteristic(Characteristic.CurrentTemperature)
    const value = await handler.handleGetRequest()
    expect(typeof value).toBe('number')
    // Tolerance covers hap-nodejs's minStep rounding (0.5°C).
    expect(Math.abs((value as number) - f2c(75))).toBeLessThan(0.5)
  })

  it('clamps target to hardware range and forwards to client', async () => {
    setTemperature.mockClear()
    const { service } = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)

    // Temperature inputs are Celsius. 100°C → way over → clamped to 110°F
    const handler = service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
    await handler.setValue(100)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeLessThanOrEqual(110)
    expect(f).toBeGreaterThanOrEqual(55)
  })

  it('reports active=0 when targetLevel is 0 (powered off)', async () => {
    const { service } = buildHeaterCoolerService('right', fakeMonitor as DacMonitor)
    const handler = service.getCharacteristic(Characteristic.Active)
    const value = await handler.handleGetRequest()
    expect(value).toBe(0)
  })

  it('stop() unsubscribes the status listener', () => {
    const off = vi.fn()
    const onSpy = vi.fn().mockReturnThis()
    const monitor = {
      on: onSpy as never,
      off: off as never,
      getLastStatus: () => status,
    }
    const { stop } = buildHeaterCoolerService('left', monitor as unknown as DacMonitor)
    stop()
    expect(off).toHaveBeenCalledWith('status:updated', expect.any(Function))
  })

  it('forwards Active=1 onSet to setPower(side, true)', async () => {
    setPower.mockClear()
    const { service } = buildHeaterCoolerService('right', fakeMonitor as DacMonitor)
    await service.getCharacteristic(Characteristic.Active).setValue(1)
    expect(setPower).toHaveBeenCalledWith('right', true)
  })

  it('forwards HeatingThreshold onSet to setTemperature with clamped F', async () => {
    setTemperature.mockClear()
    const { service } = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)
    await service.getCharacteristic(Characteristic.HeatingThresholdTemperature).setValue(-10)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeGreaterThanOrEqual(55)
    expect(f).toBeLessThanOrEqual(110)
  })

  it('returns NEUTRAL_C when monitor has no status yet', async () => {
    const blank: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => null,
    }
    const { service } = buildHeaterCoolerService('left', blank as DacMonitor)
    const value = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    // NEUTRAL_C = f2c(82.5) ≈ 28.06
    expect(typeof value).toBe('number')
    expect(value).toBeGreaterThan(27)
    expect(value).toBeLessThan(29)
  })

  it('CurrentHeaterCoolerState reflects targetLevel relative to currentLevel', async () => {
    // HEATING when targetLevel > currentLevel
    const heating: DeviceStatus = {
      ...status,
      leftSide: { currentTemperature: 70, targetTemperature: 90, currentLevel: 0, targetLevel: 50, heatingDuration: 0 },
    }
    const heatingMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => heating,
    }
    const { service: heatService } = buildHeaterCoolerService('left', heatingMonitor as DacMonitor)
    expect(await heatService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).handleGetRequest()).toBe(2)

    // COOLING when targetLevel < currentLevel
    const cooling: DeviceStatus = {
      ...status,
      leftSide: { currentTemperature: 80, targetTemperature: 60, currentLevel: 50, targetLevel: -50, heatingDuration: 0 },
    }
    const coolingMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => cooling,
    }
    const { service: coolService } = buildHeaterCoolerService('left', coolingMonitor as DacMonitor)
    expect(await coolService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).handleGetRequest()).toBe(3)

    // IDLE when levels match
    const idle: DeviceStatus = {
      ...status,
      leftSide: { currentTemperature: 70, targetTemperature: 70, currentLevel: 25, targetLevel: 25, heatingDuration: 0 },
    }
    const idleMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => idle,
    }
    const { service: idleService } = buildHeaterCoolerService('left', idleMonitor as DacMonitor)
    expect(await idleService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).handleGetRequest()).toBe(1)

    // INACTIVE when targetLevel == 0
    const offMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => status, // right side is off in fixture
    }
    const { service: offService } = buildHeaterCoolerService('right', offMonitor as DacMonitor)
    expect(await offService.getCharacteristic(Characteristic.CurrentHeaterCoolerState).handleGetRequest()).toBe(0)
  })

  it('TargetHeaterCoolerState onGet always reports AUTO (0)', async () => {
    const { service } = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)
    expect(await service.getCharacteristic(Characteristic.TargetHeaterCoolerState).handleGetRequest()).toBe(0)
  })

  it('TemperatureDisplayUnits onGet reports Celsius (0)', async () => {
    const { service } = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)
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
    const { service } = buildHeaterCoolerService('left', monitor as DacMonitor)
    expect(typeof captured).toBe('function')
    const updateSpy = vi.spyOn(service, 'updateCharacteristic')
    if (captured) (captured as (s: DeviceStatus) => void)(status)
    // Five updates: CurrentTemp, CoolingThreshold, HeatingThreshold, Active, CurrentHeaterCoolerState
    expect(updateSpy.mock.calls.length).toBeGreaterThanOrEqual(5)
  })
})
