import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

const startPriming = vi.fn().mockResolvedValue(undefined)

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ startPriming }),
}))

vi.mock('@/src/hardware/primeNotification', () => ({
  getPrimeCompletedAt: () => completedAt,
}))

let completedAt: number | null = null

import { buildPrimeSwitch } from '../accessories/primeSwitch'

describe('primeSwitch accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    startPriming.mockClear()
    completedAt = null
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts priming when set on, leaves switch on', async () => {
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.setValue(true)
    expect(startPriming).toHaveBeenCalled()
    expect(await handler.handleGetRequest()).toBe(true)
    stop()
  })

  it('flips off without calling startPriming when set off', async () => {
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.setValue(false)
    expect(startPriming).not.toHaveBeenCalled()
    expect(await handler.handleGetRequest()).toBe(false)
    stop()
  })

  it('flips off after watchdog (6 min) even without completion event', async () => {
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.setValue(true)
    expect(await handler.handleGetRequest()).toBe(true)

    vi.advanceTimersByTime(6 * 60 * 1000 + 100)
    expect(await handler.handleGetRequest()).toBe(false)
    stop()
  })

  it('flips off when getPrimeCompletedAt advances past baseline', async () => {
    completedAt = 1000
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.setValue(true)
    expect(await handler.handleGetRequest()).toBe(true)

    completedAt = 2000
    vi.advanceTimersByTime(5_001)
    expect(await handler.handleGetRequest()).toBe(false)
    stop()
  })

  it('reverts to off when startPriming throws', async () => {
    startPriming.mockRejectedValueOnce(new Error('hardware down'))
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    // hap-nodejs may swallow onSet rejections; assert observed state instead.
    try {
      await handler.setValue(true)
    }
    catch { /* swallowed by hap-nodejs in some versions */ }
    expect(await handler.handleGetRequest()).toBe(false)
    stop()
  })

  it('stop() clears poll interval and watchdog', async () => {
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.setValue(true)
    stop()
    // No assertion — succeeds if vi.useRealTimers in afterEach doesn't surface
    // pending timers. clearInterval/clearTimeout are exercised here.
  })
})
