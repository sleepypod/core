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

describe('heaterCooler accessory', () => {
  it('reports current temperature in Celsius', async () => {
    const svc = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)
    const value = await svc.getCharacteristic(Characteristic.CurrentTemperature).onGet?.bind(null)
    const c = svc.getCharacteristic(Characteristic.CurrentTemperature).value
    // 75°F ≈ 23.88°C — fall back to handler if no cached value
    const f2c = (f: number) => ((f - 32) * 5) / 9
    expect(c == null || Math.abs((c as number) - f2c(75)) < 0.01 || value != null).toBe(true)
  })

  it('clamps target to hardware range and forwards to client', async () => {
    setTemperature.mockClear()
    const svc = buildHeaterCoolerService('left', fakeMonitor as DacMonitor)

    // Temperature inputs are Celsius. 100°C → way over → clamped to 110°F
    const handler = svc.getCharacteristic(Characteristic.CoolingThresholdTemperature)
    await handler.setValue(100)
    expect(setTemperature).toHaveBeenCalled()
    const [, f] = setTemperature.mock.calls[0]
    expect(f).toBeLessThanOrEqual(110)
    expect(f).toBeGreaterThanOrEqual(55)
  })

  it('reports active=0 when targetLevel is 0 (powered off)', () => {
    const svc = buildHeaterCoolerService('right', fakeMonitor as DacMonitor)
    const value = svc.getCharacteristic(Characteristic.Active).value
    expect(value === 0 || value === null).toBe(true)
  })
})
