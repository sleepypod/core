import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic, Service } from 'hap-nodejs'
import {
  clearPumpStallNotice,
  resetPumpStallNotifications,
  setPumpStallNotice,
} from '@/src/hardware/pumpStallNotification'
import { buildPumpHealthSensor } from '../accessories/pumpHealthSensor'

describe('pumpHealthSensor accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetPumpStallNotifications()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPumpStallNotifications()
  })

  it.each([
    ['left', 'Pod pump left', 'pump-left'],
    ['right', 'Pod pump right', 'pump-right'],
  ] as const)('uses stable metadata for the %s side', (side, name, subtype) => {
    const { service, stop } = buildPumpHealthSensor(side)
    expect(service.displayName).toBe(name)
    expect(service.subtype).toBe(subtype)
    stop()
  })

  it('does not emit a redundant initial update for a healthy pump', () => {
    const update = vi.spyOn(Service.prototype, 'updateCharacteristic')
    const { stop } = buildPumpHealthSensor('left')
    expect(update).not.toHaveBeenCalled()
    stop()
  })

  it('reports LEAK_NOT_DETECTED when no stall notice is set', async () => {
    const { service, stop } = buildPumpHealthSensor('left')
    const value = await service.getCharacteristic(Characteristic.LeakDetected).handleGetRequest()
    expect(value).toBe(Characteristic.LeakDetected.LEAK_NOT_DETECTED)
    stop()
  })

  it('toggles to LEAK_DETECTED when a stall notice is set and back when cleared', async () => {
    const { service, stop } = buildPumpHealthSensor('right')
    setPumpStallNotice('right', { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(
      await service.getCharacteristic(Characteristic.LeakDetected).handleGetRequest(),
    ).toBe(Characteristic.LeakDetected.LEAK_DETECTED)

    clearPumpStallNotice('right')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(
      await service.getCharacteristic(Characteristic.LeakDetected).handleGetRequest(),
    ).toBe(Characteristic.LeakDetected.LEAK_NOT_DETECTED)
    stop()
  })

  it('stop() halts the poll interval', async () => {
    const { service, stop } = buildPumpHealthSensor('left')
    stop()
    setPumpStallNotice('left', { alertId: 1, trippedAt: 0, rpm: 0, restore: null })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(
      await service.getCharacteristic(Characteristic.LeakDetected).handleGetRequest(),
    ).toBe(Characteristic.LeakDetected.LEAK_NOT_DETECTED)
  })
})
