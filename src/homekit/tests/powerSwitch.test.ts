import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const setPower = vi.fn().mockResolvedValue(undefined)
const registerManualOverride = vi.fn()

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ setPower }),
}))
vi.mock('@/src/automation', () => ({
  getAutomationEngineIfRunning: () => ({ registerManualOverride }),
}))

import { buildPowerSwitch } from '../accessories/powerSwitch'
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

const fakeMonitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
  on: vi.fn().mockReturnThis() as never,
  getLastStatus: () => status,
}

describe('powerSwitch accessory', () => {
  beforeEach(() => {
    __resetSideController()
    setPower.mockClear()
    registerManualOverride.mockClear()
  })

  it('On.onGet reflects targetLevel !== 0', async () => {
    const { service: leftSvc } = buildPowerSwitch('left', fakeMonitor as DacMonitor)
    expect(await leftSvc.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(true)

    const { service: rightSvc } = buildPowerSwitch('right', fakeMonitor as DacMonitor)
    expect(await rightSvc.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false)
  })

  it('On.onSet routes to setPower and preserves the last target on power-on', async () => {
    const { service } = buildPowerSwitch('left', fakeMonitor as DacMonitor)
    // handleSetRequest properly awaits onSet's full chain; setValue's await
    // resolves on `this` and skips microtasks scheduled inside the chain.
    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)
    // Left fixture targetTemperature is 70°F — must pass through so the
    // hardware client doesn't fall back to its hardcoded 75°F default.
    expect(setPower).toHaveBeenCalledWith('left', true, 70)

    setPower.mockClear()
    await service.getCharacteristic(Characteristic.On).handleSetRequest(false)
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('returns false when monitor has no status yet', async () => {
    const blank: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: vi.fn().mockReturnThis() as never,
      getLastStatus: () => null,
    }
    const { service } = buildPowerSwitch('left', blank as DacMonitor)
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false)
  })

  it('subscribed status:updated handler pushes On updates', () => {
    let captured: ((s: DeviceStatus) => void) | null = null
    const onSpy = vi.fn((evt: string, fn: (s: DeviceStatus) => void) => {
      if (evt === 'status:updated') captured = fn
      return monitor as unknown as DacMonitor
    })
    const monitor: Pick<DacMonitor, 'on' | 'getLastStatus'> = {
      on: onSpy as never,
      getLastStatus: () => status,
    }
    const { service } = buildPowerSwitch('left', monitor as DacMonitor)
    expect(typeof captured).toBe('function')
    const updateSpy = vi.spyOn(service, 'updateCharacteristic')
    if (captured) (captured as (s: DeviceStatus) => void)(status)
    expect(updateSpy).toHaveBeenCalledWith(Characteristic.On, true)
  })

  it('stop() unsubscribes the status listener', () => {
    const off = vi.fn()
    const onSpy = vi.fn().mockReturnThis()
    const monitor = {
      on: onSpy as never,
      off: off as never,
      getLastStatus: () => status,
    }
    const { stop } = buildPowerSwitch('left', monitor as unknown as DacMonitor)
    stop()
    expect(off).toHaveBeenCalledWith('status:updated', expect.any(Function))
  })
})
