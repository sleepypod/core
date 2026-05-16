import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'

let rows: Array<{ peak: number | null }> = []
const all = vi.fn(() => rows)

vi.mock('@/src/db/biometrics', () => ({
  biometricsDb: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({ all }),
        }),
      }),
    }),
  },
}))

vi.mock('@/src/db/biometrics-schema', () => ({
  movement: { side: {}, timestamp: {}, totalMovement: {} },
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

  it('reports OCCUPANCY_NOT_DETECTED when no movement rows exist', async () => {
    rows = [{ peak: null }]
    const { service, stop } = buildOccupancySensor('left')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    stop()
  })

  it('reports OCCUPANCY_NOT_DETECTED for empty-bed baseline noise', async () => {
    rows = [{ peak: 30 }]
    const { service, stop } = buildOccupancySensor('right')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED)
    stop()
  })

  it('reports OCCUPANCY_DETECTED when peak movement crosses the threshold', async () => {
    rows = [{ peak: 50 }]
    const { service, stop } = buildOccupancySensor('right')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED)
    stop()
  })

  it('reports OCCUPANCY_DETECTED for a clear movement spike', async () => {
    rows = [{ peak: 662 }]
    const { service, stop } = buildOccupancySensor('left')
    const value = await service.getCharacteristic(Characteristic.OccupancyDetected).handleGetRequest()
    expect(value).toBe(Characteristic.OccupancyDetected.OCCUPANCY_DETECTED)
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
    rows = [{ peak: 0 }]
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
