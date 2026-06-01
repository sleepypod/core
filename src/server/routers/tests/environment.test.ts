/**
 * Tests for the environment router — bedTemp/freezerTemp date-range queries
 * with F/C unit conversion, latest fetchers, and the bed+freezer summary
 * pair (Promise.all chain). biometricsDb mocked via a thenable chain.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbState = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  pop(): unknown[] {
    return dbState.rowsQueue.shift() ?? []
  },
}))

const dbMock = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.pop()).then(resolve)
    chain.where = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    return chain
  }
  return { select: vi.fn(() => makeChain()) }
})

vi.mock('@/src/db', () => ({
  db: {},
  biometricsDb: dbMock,
}))

const { environmentRouter } = await import('@/src/server/routers/environment')
const caller = environmentRouter.createCaller({})

beforeEach(() => {
  dbState.rowsQueue.length = 0
  dbMock.select.mockClear()
})

describe('environment.getBedTemp', () => {
  it('returns rows with Fahrenheit conversion by default', async () => {
    dbState.rowsQueue.push([
      {
        id: 1, timestamp: new Date(0),
        ambientTemp: 2000, mcuTemp: 2500, humidity: 5000,
        leftOuterTemp: 2100, leftCenterTemp: 2200, leftInnerTemp: 2300,
        rightOuterTemp: 2400, rightCenterTemp: 2500, rightInnerTemp: 2600,
      },
    ])

    const out = await caller.getBedTemp({ limit: 10 })
    expect(out).toHaveLength(1)
    // 20°C = 68°F (centidegrees 2000 -> 20°C -> 68°F)
    expect(out[0].ambientTemp).toBe(68)
    expect(out[0].humidity).toBe(50)
  })

  it('returns Celsius when unit=C', async () => {
    dbState.rowsQueue.push([
      {
        id: 1, timestamp: new Date(0),
        ambientTemp: 2000, mcuTemp: null, humidity: null,
        leftOuterTemp: null, leftCenterTemp: null, leftInnerTemp: null,
        rightOuterTemp: null, rightCenterTemp: null, rightInnerTemp: null,
      },
    ])

    const out = await caller.getBedTemp({ limit: 10, unit: 'C' })
    expect(out[0].ambientTemp).toBe(20)
    expect(out[0].mcuTemp).toBeNull()
  })

  it('rejects inverted date range as BAD_REQUEST', async () => {
    await expect(caller.getBedTemp({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate must be before or equal to endDate/)
  })
})

describe('environment.getFreezerTemp', () => {
  it('returns rows with C conversion', async () => {
    dbState.rowsQueue.push([
      {
        id: 1, timestamp: new Date(0),
        ambientTemp: 2000, heatsinkTemp: 3000, leftWaterTemp: 1500, rightWaterTemp: 1600,
      },
    ])

    const out = await caller.getFreezerTemp({ limit: 10, unit: 'C' })
    expect(out[0].ambientTemp).toBe(20)
    expect(out[0].heatsinkTemp).toBe(30)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getFreezerTemp({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate/)
  })
})

describe('environment.getLatestBedTemp / getLatestFreezerTemp', () => {
  it('returns null when no row', async () => {
    dbState.rowsQueue.push([])
    const out = await caller.getLatestBedTemp({})
    expect(out).toBeNull()
  })

  it('latest bed temp returns the row', async () => {
    dbState.rowsQueue.push([{
      id: 7, timestamp: new Date(0),
      ambientTemp: 2000, mcuTemp: null, humidity: null,
      leftOuterTemp: null, leftCenterTemp: null, leftInnerTemp: null,
      rightOuterTemp: null, rightCenterTemp: null, rightInnerTemp: null,
    }])
    const out = await caller.getLatestBedTemp({})
    expect(out?.id).toBe(7)
  })

  it('latest freezer temp returns null when missing', async () => {
    dbState.rowsQueue.push([])
    const out = await caller.getLatestFreezerTemp({})
    expect(out).toBeNull()
  })

  it('latest freezer temp returns the row', async () => {
    dbState.rowsQueue.push([{
      id: 1, timestamp: new Date(0),
      ambientTemp: 2000, heatsinkTemp: null, leftWaterTemp: null, rightWaterTemp: null,
    }])
    const out = await caller.getLatestFreezerTemp({ unit: 'C' })
    expect(out?.ambientTemp).toBe(20)
  })
})

describe('environment.getSummary', () => {
  it('returns nulls for sections with no records', async () => {
    // Both summary queries fire in Promise.all → push two responses
    dbState.rowsQueue.push([{ avgAmbient: null, minAmbient: null, maxAmbient: null, avgHumidity: null, avgLeftCenter: null, avgRightCenter: null, recordCount: 0 }])
    dbState.rowsQueue.push([{ avgAmbient: null, avgHeatsink: null, avgLeftWater: null, avgRightWater: null, recordCount: 0 }])

    const out = await caller.getSummary({
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out.bedTemp).toBeNull()
    expect(out.freezerTemp).toBeNull()
  })

  it('returns aggregated values when records present', async () => {
    dbState.rowsQueue.push([{
      avgAmbient: '2000', minAmbient: 1500, maxAmbient: 2500,
      avgHumidity: '5000', avgLeftCenter: '2100', avgRightCenter: '2200',
      recordCount: 60,
    }])
    dbState.rowsQueue.push([{
      avgAmbient: '1000', avgHeatsink: '3000', avgLeftWater: '500', avgRightWater: '600',
      recordCount: 60,
    }])

    const out = await caller.getSummary({
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
      unit: 'C',
    })
    expect(out.bedTemp?.avgAmbientTemp).toBe(20) // 2000 cdeg = 20°C
    expect(out.bedTemp?.avgHumidity).toBe(50)
    expect(out.bedTemp?.recordCount).toBe(60)
    expect(out.freezerTemp?.avgAmbientTemp).toBe(10)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getSummary({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    })).rejects.toThrow(/startDate/)
  })
})

describe('environment.getAmbientLight', () => {
  it('returns rows', async () => {
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(0), lux: 100 }])
    const out = await caller.getAmbientLight({ limit: 10 })
    expect(out).toHaveLength(1)
    expect(out[0].lux).toBe(100)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getAmbientLight({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate/)
  })
})

describe('environment.getLatestAmbientLight', () => {
  it('returns null when no row', async () => {
    dbState.rowsQueue.push([])
    const out = await caller.getLatestAmbientLight({})
    expect(out).toBeNull()
  })

  it('returns row when present', async () => {
    dbState.rowsQueue.push([{ id: 5, timestamp: new Date(0), lux: 50 }])
    const out = await caller.getLatestAmbientLight({})
    expect(out?.id).toBe(5)
  })
})

describe('environment.getAmbientLightSummary', () => {
  it('returns null when recordCount=0', async () => {
    dbState.rowsQueue.push([{ avgLux: null, minLux: null, maxLux: null, recordCount: 0 }])
    const out = await caller.getAmbientLightSummary({
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out).toBeNull()
  })

  it('returns summary stats when present', async () => {
    dbState.rowsQueue.push([{ avgLux: '120', minLux: 5, maxLux: 500, recordCount: 144 }])
    const out = await caller.getAmbientLightSummary({
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out?.avgLux).toBe(120)
    expect(out?.recordCount).toBe(144)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getAmbientLightSummary({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    })).rejects.toThrow(/startDate/)
  })
})

describe('environment error wrappers', () => {
  it('wraps each query DB failure as INTERNAL_SERVER_ERROR', async () => {
    const boom = (): never => {
      throw new Error('db dead')
    }

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getBedTemp({
      startDate: new Date('2025-01-01'), endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Failed to fetch bed temp/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getFreezerTemp({
      startDate: new Date('2025-01-01'), endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Failed to fetch freezer temp/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getLatestBedTemp({})).rejects.toThrow(/Failed to fetch latest bed temp/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getLatestFreezerTemp({})).rejects.toThrow(/Failed to fetch latest freezer temp/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getSummary({
      startDate: new Date('2025-01-01'), endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Failed to calculate environment summary/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getAmbientLight({
      startDate: new Date('2025-01-01'), endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Failed to fetch ambient light/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getLatestAmbientLight({})).rejects.toThrow(/Failed to fetch latest ambient light/)

    dbMock.select.mockImplementationOnce(boom)
    await expect(caller.getAmbientLightSummary({
      startDate: new Date('2025-01-01'), endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Failed to calculate ambient light summary/)
  })
})
