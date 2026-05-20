import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

// Hoisted DB mock — drives readAmbientC by stubbing the chained
// biometricsDb.select().from().orderBy().limit() call.
const dbMock = vi.hoisted(() => {
  const state: { row: { ambientTemp: number | null } | null, throws: boolean } = {
    row: null,
    throws: false,
  }
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      orderBy: vi.fn(() => ({
        limit: vi.fn(async () => {
          if (state.throws) throw new Error('biometrics db down')
          return state.row ? [state.row] : []
        }),
      })),
    })),
  }))
  return { state, select }
})

vi.mock('@/src/db', () => ({
  biometricsDb: { select: dbMock.select },
}))

import { buildAmbientSensor } from '../accessories/ambientSensor'

describe('ambientSensor accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    dbMock.state.row = null
    dbMock.state.throws = false
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads latest ambient_temp (centidegrees) and converts to Celsius', async () => {
    dbMock.state.row = { ambientTemp: 2150 } // 21.5°C
    const { service, stop } = buildAmbientSensor()
    // First refresh is queued by buildAmbientSensor — drain the microtask
    // before sampling so the converted value is in place.
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()
    await Promise.resolve()
    const value = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    expect(value).toBeCloseTo(21.5, 2)
    stop()
  })

  it('returns the neutral 20°C sentinel before the first DB row resolves', async () => {
    // No row queued; readAmbientC returns null and lastC stays at the sentinel.
    const { service, stop } = buildAmbientSensor()
    const value = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    expect(value).toBe(20)
    stop()
  })

  it('keeps last known value when the latest row has a null ambient_temp', async () => {
    dbMock.state.row = { ambientTemp: 2000 } // 20°C — happens to match sentinel
    const { service, stop } = buildAmbientSensor()
    await Promise.resolve()
    await Promise.resolve()

    dbMock.state.row = { ambientTemp: null }
    await vi.advanceTimersByTimeAsync(60_000)
    const value = await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()
    expect(value).toBe(20)
    stop()
  })

  it('swallows DB errors and leaves the cached value untouched', async () => {
    dbMock.state.row = { ambientTemp: 2500 } // 25°C
    const { service, stop } = buildAmbientSensor()
    await Promise.resolve()
    await Promise.resolve()
    expect(await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).toBeCloseTo(25, 2)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throws = true
    await vi.advanceTimersByTimeAsync(60_000)
    expect(warnSpy).toHaveBeenCalled()
    // 25°C still cached.
    expect(await service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest()).toBeCloseTo(25, 2)
    warnSpy.mockRestore()
    stop()
  })

  it('polls the DB on a 60s cadence', async () => {
    dbMock.state.row = { ambientTemp: 2000 }
    const { stop } = buildAmbientSensor()
    const before = dbMock.select.mock.calls.length
    await vi.advanceTimersByTimeAsync(180_000)
    // Three additional polls in 180s.
    expect(dbMock.select.mock.calls.length).toBeGreaterThanOrEqual(before + 3)
    stop()
  })

  it('stop() halts the poll interval', async () => {
    const { stop } = buildAmbientSensor()
    await Promise.resolve()
    const after = dbMock.select.mock.calls.length
    stop()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(dbMock.select.mock.calls.length).toBe(after)
  })
})
