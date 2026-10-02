// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({ query: vi.fn<() => Promise<unknown[]>>() }))
vi.mock('@/src/db', () => ({
  biometricsDb: {
    select: () => ({ from: () => ({ orderBy: () => ({ limit: dbMock.query }) }) }),
  },
}))

import { getDeviceEnrichment } from '../deviceEnrichment'

let now = 0
const timestamp = new Date('2026-09-05T12:00:00Z')
const climate = { ambientTemp: 2150, humidity: 4500, timestamp }
const water = { raw: 1234, calibratedEmpty: 500, calibratedFull: 2000, timestamp }

beforeEach(() => {
  delete (globalThis as Record<string, unknown>).__sp_device_enrichment__
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  dbMock.query.mockReset().mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (globalThis as Record<string, unknown>).__sp_device_enrichment__
})

describe('device enrichment cache', () => {
  it('shares a pending read and exposes sidecar updates after the two-second TTL', async () => {
    let release!: (rows: unknown[]) => void
    dbMock.query.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve
    }))
      .mockResolvedValueOnce([water])

    const pending = Array.from({ length: 10 }, () => getDeviceEnrichment())
    expect(new Set(pending).size).toBe(1)
    expect(dbMock.query).toHaveBeenCalledOnce()
    // Cache age starts after the completed read, not while a DB query is pending.
    now = 500
    release([climate])
    const [first] = await Promise.all(pending)
    expect(first.roomClimate).toEqual({ temperatureC: 21.5, humidity: 45, timestamp: timestamp.getTime() })
    expect(first.waterLevelRaw).toEqual({ ...water, timestamp: timestamp.getTime() })

    now = 2_499
    expect(await getDeviceEnrichment()).toEqual(first)
    expect(dbMock.query).toHaveBeenCalledTimes(2)
    now = 2_500
    dbMock.query.mockResolvedValueOnce([{ ...climate, ambientTemp: 2300 }]).mockResolvedValueOnce([water])
    expect((await getDeviceEnrichment()).roomClimate.temperatureC).toBe(23)
    expect(dbMock.query).toHaveBeenCalledTimes(4)
  })

  it.each(['climate', 'water'] as const)('isolates a failed %s query and retries after the TTL', async (failed) => {
    if (failed === 'climate') {
      dbMock.query.mockRejectedValueOnce(new Error('bed table busy')).mockResolvedValueOnce([water])
    }
    else {
      dbMock.query.mockResolvedValueOnce([climate]).mockRejectedValueOnce(new Error('water table busy'))
    }

    const first = await getDeviceEnrichment()
    expect(first.roomClimate.temperatureC).toBe(failed === 'climate' ? null : 21.5)
    expect(first.waterLevelRaw.raw).toBe(failed === 'water' ? null : 1234)
    expect(await getDeviceEnrichment()).toEqual(first)
    expect(dbMock.query).toHaveBeenCalledTimes(2)

    now = 2_000
    dbMock.query.mockResolvedValueOnce([climate]).mockResolvedValueOnce([water])
    const recovered = await getDeviceEnrichment()
    expect(recovered.roomClimate.temperatureC).toBe(21.5)
    expect(recovered.waterLevelRaw.raw).toBe(1234)
    expect(dbMock.query).toHaveBeenCalledTimes(4)
  })

  it('replaces expired readings with nulls when both queries fail', async () => {
    dbMock.query.mockResolvedValueOnce([climate]).mockResolvedValueOnce([water])
    await getDeviceEnrichment()
    now = 2_000
    dbMock.query.mockRejectedValue(new Error('database unavailable'))

    expect(await getDeviceEnrichment()).toEqual({
      roomClimate: { temperatureC: null, humidity: null, timestamp: null },
      waterLevelRaw: { raw: null, calibratedEmpty: null, calibratedFull: null, timestamp: null },
    })
  })

  it('shares cached enrichment across separate Next module instances', async () => {
    dbMock.query.mockResolvedValueOnce([climate]).mockResolvedValueOnce([water])
    const first = await getDeviceEnrichment()
    vi.resetModules()
    const duplicate = await import('../deviceEnrichment')

    expect(await duplicate.getDeviceEnrichment()).toEqual(first)
    expect(dbMock.query).toHaveBeenCalledTimes(2)
  })
})
