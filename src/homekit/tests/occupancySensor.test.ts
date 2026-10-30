import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'
import Database from 'better-sqlite3'
import '@/src/auth/tests/support'
import type { OccupancyResult } from '@/src/lib/occupancy'

const occupancyMock = vi.fn<(side: 'left' | 'right') => OccupancyResult>()

vi.mock('@/src/lib/occupancy', () => ({
  getOccupancy: (side: 'left' | 'right') => occupancyMock(side),
}))

import { buildOccupancySensor } from '../accessories/occupancySensor'

function result(occupied: boolean): OccupancyResult {
  return {
    occupied,
    available: true,
    classification: occupied ? 'person' : 'none',
    movement: { active: occupied, peakScore: occupied ? 660 : 12 },
    level: { active: false, deviation: null, threshold: null, ageMs: null, zoneDeviations: null, zones: null },
    vitals: { heartRate: null, breathingRate: null, humanRange: null },
  }
}

describe('occupancySensor accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    occupancyMock.mockReset()
    occupancyMock.mockReturnValue(result(false))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(['left', 'right'] as const)('uses stable metadata for the %s side', (side) => {
    const { service, stop } = buildOccupancySensor(side)
    expect(service.displayName).toBe(`Bed ${side} occupancy`)
    expect(service.subtype).toBe(side)
    stop()
  })

  it('does not require Node-specific unref support on the poll handle', () => {
    const interval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(7 as never)
    expect(() => buildOccupancySensor('left')).not.toThrow()
    interval.mockRestore()
  })

  it('reports OCCUPANCY_NOT_DETECTED when the virtual sensor returns occupied=false', async () => {
    occupancyMock.mockReturnValue(result(false))
    const { service, stop } = buildOccupancySensor('left')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    stop()
  })

  it('reports OCCUPANCY_DETECTED when the virtual sensor returns occupied=true', async () => {
    occupancyMock.mockReturnValue(result(true))
    const { service, stop } = buildOccupancySensor('right')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED)
    stop()
  })

  it('faults when occupancy is unavailable instead of reporting an empty bed', async () => {
    occupancyMock.mockReturnValue({ ...result(false), available: false })
    const { service, stop } = buildOccupancySensor('left')
    await expect(service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()).rejects.toBe(-70402)
    expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(1)
    occupancyMock.mockReturnValue(result(true))
    vi.advanceTimersByTime(5000)
    expect(await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()).toBe(1)
    expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(0)
    stop()
  })

  it('passes through the requested side to the virtual sensor', async () => {
    occupancyMock.mockReturnValue(result(false))
    const { stop } = buildOccupancySensor('right')
    expect(occupancyMock).toHaveBeenCalledWith('right')
    stop()
  })

  it('withdraws shared occupancy after personal activation without replacing the accessory', async () => {
    occupancyMock.mockReturnValue(result(true))
    const { service, stop } = buildOccupancySensor('left')
    const identity = { UUID: service.UUID, subtype: service.subtype }
    const characteristic = service.getCharacteristic(Characteristic.OccupancyDetected)
    expect(await characteristic.handleGetRequest()).toBe(1)
    const path = process.env.DATABASE_URL
    if (!path) throw new Error('Privacy fixture is unavailable')
    const database = new Database(path)
    database.prepare('INSERT INTO household_privacy_boundary VALUES (1, ?, ?)').run(Date.now(), 'assigned')
    database.close()
    occupancyMock.mockClear()

    await expect(characteristic.handleGetRequest()).rejects.toBe(-70402)
    vi.advanceTimersByTime(5000)
    expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(1)
    expect(occupancyMock).not.toHaveBeenCalled()
    expect({ UUID: service.UUID, subtype: service.subtype }).toEqual(identity)
    await expect(characteristic.handleGetRequest()).rejects.toBe(-70402)
    stop()
  })

  it('withdraws shared occupancy when its privacy storage cannot be verified', async () => {
    occupancyMock.mockReturnValue(result(true))
    const { service, stop } = buildOccupancySensor('right')
    const characteristic = service.getCharacteristic(Characteristic.OccupancyDetected)
    expect(await characteristic.handleGetRequest()).toBe(1)
    vi.stubEnv('DATABASE_URL', `${process.env.DATABASE_URL}.missing`)
    occupancyMock.mockClear()

    vi.advanceTimersByTime(5000)
    await expect(characteristic.handleGetRequest()).rejects.toBe(-70402)
    expect(service.getCharacteristic(Characteristic.StatusFault).value).toBe(1)
    expect(occupancyMock).not.toHaveBeenCalled()
    stop()
  })

  it('polls occupancy on interval', () => {
    const { stop } = buildOccupancySensor('left')
    const before = occupancyMock.mock.calls.length
    vi.advanceTimersByTime(15_000)
    expect(occupancyMock.mock.calls.length).toBeGreaterThan(before)
    stop()
  })

  it('stop() clears the poll interval', () => {
    const { stop } = buildOccupancySensor('left')
    stop()
    const after = occupancyMock.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(occupancyMock.mock.calls.length).toBe(after)
  })
})
