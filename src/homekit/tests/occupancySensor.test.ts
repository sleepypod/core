import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

let rows: Array<{ leftBedAt: number | null }> = []
const all = vi.fn(() => rows)

vi.mock('@/src/db/biometrics', () => ({
  biometricsDb: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({ all }),
          }),
        }),
      }),
    }),
  },
}))

vi.mock('@/src/db/biometrics-schema', () => ({
  sleepRecords: { side: {}, leftBedAt: {}, enteredBedAt: {} },
}))

import { buildOccupancySensor } from '../accessories/occupancySensor'

describe('occupancySensor accessory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    rows = []
    all.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports OCCUPANCY_NOT_DETECTED when no sleep records exist', async () => {
    rows = []
    const { service, stop } = buildOccupancySensor('left')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    stop()
  })

  it('reports OCCUPANCY_DETECTED when latest record has null leftBedAt', async () => {
    rows = [{ leftBedAt: null }]
    const { service, stop } = buildOccupancySensor('right')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED)
    stop()
  })

  it('reports OCCUPANCY_NOT_DETECTED when latest record has leftBedAt set', async () => {
    rows = [{ leftBedAt: 1000 }]
    const { service, stop } = buildOccupancySensor('left')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    stop()
  })

  it('tolerates db query errors and returns NOT_DETECTED', async () => {
    all.mockImplementationOnce(() => {
      throw new Error('db gone')
    })
    const { service, stop } = buildOccupancySensor('left')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    stop()
  })

  it('polls presence on interval', async () => {
    rows = []
    const { stop } = buildOccupancySensor('left')
    const before = all.mock.calls.length
    vi.advanceTimersByTime(15_000)
    expect(all.mock.calls.length).toBeGreaterThan(before)
    stop()
  })

  it('stop() clears the poll interval', () => {
    const { stop } = buildOccupancySensor('left')
    stop()
    const after = all.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(all.mock.calls.length).toBe(after)
  })
})
