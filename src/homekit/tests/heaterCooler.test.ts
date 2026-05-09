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
})
