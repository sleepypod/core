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

  it('uses the stable HomeKit display name and subtype and starts off', async () => {
    const { service, stop } = buildPrimeSwitch()
    expect(service.displayName).toBe('Prime pod')
    expect(service.subtype).toBe('prime')
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false)
    stop()
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

  it('propagates a priming failure from the characteristic handler', async () => {
    const failure = new Error('hardware down')
    startPriming.mockRejectedValueOnce(failure)
    const { service, stop } = buildPrimeSwitch()

    await expect(
      service.getCharacteristic(Characteristic.On).handleSetRequest(true),
    // hap-nodejs maps handler errors to HAP's SERVICE_COMMUNICATION_FAILURE.
    ).rejects.toBe(-70402)
    expect(await service.getCharacteristic(Characteristic.On).handleGetRequest()).toBe(false)
    stop()
  })

  it('does not complete when the notification remains null or at the baseline', async () => {
    completedAt = 1000
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.handleSetRequest(true)

    vi.advanceTimersByTime(5_000)
    expect(await handler.handleGetRequest()).toBe(true)
    completedAt = null
    vi.advanceTimersByTime(5_000)
    expect(await handler.handleGetRequest()).toBe(true)
    stop()
  })

  it('clears the watchdog exactly once when completion is observed', async () => {
    completedAt = 1000
    const clear = vi.spyOn(globalThis, 'clearTimeout')
    const { service, stop } = buildPrimeSwitch()
    await service.getCharacteristic(Characteristic.On).handleSetRequest(true)

    completedAt = 2000
    vi.advanceTimersByTime(5_000)
    expect(clear).toHaveBeenCalledOnce()
    stop()
    expect(clear).toHaveBeenCalledOnce()
  })

  it('does not require unref support on watchdog or poll handles', async () => {
    vi.spyOn(globalThis, 'setInterval').mockReturnValue(7 as never)
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(8 as never)
    const { service } = buildPrimeSwitch()

    await expect(
      service.getCharacteristic(Characteristic.On).handleSetRequest(true),
    ).resolves.toBeUndefined()
  })

  it('stop() clears poll interval and watchdog', async () => {
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    const { service, stop } = buildPrimeSwitch()
    const handler = service.getCharacteristic(Characteristic.On)
    await handler.setValue(true)
    stop()
    expect(clearIntervalSpy).toHaveBeenCalledOnce()
    expect(clearTimeoutSpy).toHaveBeenCalledOnce()
  })
})
