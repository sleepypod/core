/**
 * Tests for the water-level router — happy path of every procedure plus the
 * BAD_REQUEST date-range rejection (getHistory) and NOT_FOUND alert dismissal.
 *
 * biometricsDb is mocked with a thin chain that always terminates in an
 * awaitable returning whatever the test queues into `nextRows`/`nextRow`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbState = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  pop(): unknown[] {
    return dbState.rowsQueue.shift() ?? []
  },
}))

const dbMock = vi.hoisted(() => {
  // Each query terminates in either .limit() or .orderBy() depending on the
  // procedure. Both must be awaitable AND chainable. Use a thenable so an
  // awaiter consumes the row queue.
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.pop()).then(resolve)
    chain.where = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.groupBy = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.returning = vi.fn(() => chain)
    return chain
  }

  const select = vi.fn(() => makeChain())
  const update = vi.fn(() => makeChain())
  const insert = vi.fn(() => makeChain())
  const del = vi.fn(() => makeChain())

  return { select, update, insert, delete: del }
})

vi.mock('@/src/db', () => ({
  db: {},
  biometricsDb: dbMock,
}))

const { waterLevelRouter } = await import('@/src/server/routers/waterLevel')
const caller = waterLevelRouter.createCaller({})

beforeEach(() => {
  dbState.rowsQueue.length = 0
  dbMock.select.mockClear()
  dbMock.update.mockClear()
  dbMock.insert.mockClear()
  dbMock.delete.mockClear()
})

describe('waterLevel.getHistory', () => {
  it('returns rows when no date range is supplied', async () => {
    dbState.rowsQueue.push([
      { id: 1, timestamp: new Date(0), level: 'ok' },
      { id: 2, timestamp: new Date(1000), level: 'low' },
    ])

    const result = await caller.getHistory({ limit: 100 })
    expect(result).toHaveLength(2)
    expect(result[0].level).toBe('ok')
  })

  it('rejects inverted startDate / endDate as BAD_REQUEST', async () => {
    await expect(caller.getHistory({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate must be before or equal to endDate/)
  })
})

describe('waterLevel.getLatest', () => {
  it('returns the latest row', async () => {
    dbState.rowsQueue.push([{ id: 7, timestamp: new Date(0), level: 'ok' }])
    const result = await caller.getLatest({})
    expect(result?.id).toBe(7)
  })

  it('returns null when no rows', async () => {
    dbState.rowsQueue.push([])
    const result = await caller.getLatest({})
    expect(result).toBeNull()
  })
})

describe('waterLevel.getTrend', () => {
  it('returns unknown trend when fewer than 2 readings', async () => {
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 1 },
    ])
    const result = await caller.getTrend({ hours: 24 })
    expect(result.trend).toBe('unknown')
    expect(result.totalReadings).toBe(1)
    expect(result.okPercent).toBe(100)
  })

  it('computes declining trend when recent low rate exceeds older by >0.2', async () => {
    // Order matters — totals first, then recentLow, olderLow, recentTotal, olderTotal
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 50 },
      { level: 'low', cnt: 50 },
    ])
    dbState.rowsQueue.push([{ cnt: 40 }])  // recentLow
    dbState.rowsQueue.push([{ cnt: 10 }])  // olderLow
    dbState.rowsQueue.push([{ cnt: 50 }])  // recentTotal
    dbState.rowsQueue.push([{ cnt: 50 }])  // olderTotal

    const result = await caller.getTrend({ hours: 24 })
    expect(result.trend).toBe('declining')
    expect(result.totalReadings).toBe(100)
  })

  it('computes rising trend when recent low rate is much lower than older', async () => {
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 50 },
      { level: 'low', cnt: 50 },
    ])
    dbState.rowsQueue.push([{ cnt: 10 }])  // recentLow
    dbState.rowsQueue.push([{ cnt: 40 }])  // olderLow
    dbState.rowsQueue.push([{ cnt: 50 }])
    dbState.rowsQueue.push([{ cnt: 50 }])

    const result = await caller.getTrend({ hours: 24 })
    expect(result.trend).toBe('rising')
  })
})

describe('waterLevel.getAlerts', () => {
  it('returns active (undismissed) alerts', async () => {
    dbState.rowsQueue.push([
      {
        id: 1, type: 'low_sustained', startedAt: new Date(0),
        dismissedAt: null, message: 'low for 30m', createdAt: new Date(0),
      },
    ])
    const result = await caller.getAlerts({})
    expect(result).toHaveLength(1)
    expect(result[0].dismissedAt).toBeNull()
  })
})

describe('waterLevel.dismissAlert', () => {
  it('marks an alert dismissed', async () => {
    dbState.rowsQueue.push([
      { id: 5, type: 'low_sustained', startedAt: new Date(0), dismissedAt: new Date(), message: null, createdAt: new Date(0) },
    ])
    const result = await caller.dismissAlert({ id: 5 })
    expect(result).toEqual({ success: true })
  })

  it('throws NOT_FOUND when nothing was updated', async () => {
    dbState.rowsQueue.push([])
    await expect(caller.dismissAlert({ id: 999 })).rejects.toThrow(/Alert 999 not found/)
  })
})

describe('waterLevel.getFlowReadings / getLatestFlowReading', () => {
  it('returns flow rows for the requested window', async () => {
    dbState.rowsQueue.push([
      { id: 1, timestamp: new Date(0), leftFlowrateCd: 100, rightFlowrateCd: 110, leftPumpRpm: 1500, rightPumpRpm: 1600 },
    ])
    const result = await caller.getFlowReadings({ hours: 24 })
    expect(result).toHaveLength(1)
    expect(result[0].leftFlowrateCd).toBe(100)
  })

  it('getLatestFlowReading returns null when no rows', async () => {
    dbState.rowsQueue.push([])
    const result = await caller.getLatestFlowReading({})
    expect(result).toBeNull()
  })

  it('getLatestFlowReading returns the row when one exists', async () => {
    dbState.rowsQueue.push([{ id: 9, timestamp: new Date(0), leftFlowrateCd: null, rightFlowrateCd: null, leftPumpRpm: null, rightPumpRpm: null }])
    const result = await caller.getLatestFlowReading({})
    expect(result?.id).toBe(9)
  })
})
