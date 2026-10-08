import { describe, expect, it, vi } from 'vitest'
import { BED_TEMPERATURE_SAMPLES, recordedBedTemperature } from '../bedTemperatureSamples'
import { environment } from '../handlers/environment'
import { bedTempFrame } from '../sensorFrames'
import { normalizeFrame } from '@/src/streaming/normalizeFrame'

// A single fixture must feed HTTP and WS so connecting never replaces the
// captured spatial pattern with unrelated generated values.
describe('recorded temperature demo', () => {
  it('replays the observed spatial pattern in firmware channel order', () => {
    const reading = recordedBedTemperature(0)
    expect(reading).toMatchObject({ leftOuterTemp: 26.34, leftCenterTemp: 26.8, leftInnerTemp: 26.12, rightOuterTemp: 24.46, rightCenterTemp: 24.96, rightInnerTemp: 24.83 })
    expect(normalizeFrame(bedTempFrame(0))).toMatchObject(reading)
    expect(recordedBedTemperature(BED_TEMPERATURE_SAMPLES.length * 16)).toEqual(reading)
  })
  it('uses matching measurements and timestamps for the HTTP fallback, converting units', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    try {
      const reading = recordedBedTemperature(1000)
      const c = await environment.getLatestBedTemp?.({ unit: 'C' })
      const f = await environment.getLatestBedTemp?.({ unit: 'F' })
      expect(c).toMatchObject({ ...reading, timestamp: new Date(1_000_000) })
      expect(f?.leftCenterTemp).toBeCloseTo(reading.leftCenterTemp * 9 / 5 + 32)
      expect(f?.humidity).toBe(reading.humidity)
    }
    finally { vi.useRealTimers() }
  })
  it('serves history and summary from the same recording as the latest reading', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_020_000)
    try {
      const latest = await environment.getLatestBedTemp?.({ unit: 'C' })
      const [row] = await environment.getBedTemp?.({ unit: 'C', limit: 1 }) ?? []
      expect(row).toMatchObject({ ...latest, id: row?.id })
      const summary = await environment.getSummary?.({ startDate: new Date(1_020_000), endDate: new Date(1_020_000), unit: 'C' })
      expect(summary?.bedTemp?.avgLeftCenterTemp).toBe(latest?.leftCenterTemp)
    }
    finally { vi.useRealTimers() }
  })
})
