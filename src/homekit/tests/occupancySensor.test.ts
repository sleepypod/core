import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Characteristic } from 'hap-nodejs'
import type { OccupancyResult } from '@/src/lib/occupancy'

const occupancyMock = vi.fn<(side: 'left' | 'right') => OccupancyResult>()

vi.mock('@/src/lib/occupancy', () => ({
  getOccupancy: (side: 'left' | 'right') => occupancyMock(side),
}))

import { buildOccupancySensor } from '../accessories/occupancySensor'

function result(occupied: boolean): OccupancyResult {
  return {
    occupied,
    movement: { active: occupied, peakScore: occupied ? 660 : 12 },
    level: { active: false, deviation: null, threshold: null, ageMs: null },
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

  it('passes through the requested side to the virtual sensor', async () => {
    occupancyMock.mockReturnValue(result(false))
    const { stop } = buildOccupancySensor('right')
    expect(occupancyMock).toHaveBeenCalledWith('right')
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
