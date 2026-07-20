/**
 * Tests for the water-level router — happy path of every procedure plus the
 * BAD_REQUEST date-range rejection (getHistory) and NOT_FOUND alert dismissal.
 *
 * biometricsDb is mocked with a thin chain that always terminates in an
 * awaitable returning whatever the test queues into `nextRows`/`nextRow`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DrizzleOrmModule from 'drizzle-orm'

const sqlMock = vi.hoisted(() => ({
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  gte: vi.fn((left: unknown, right: unknown) => ({ op: 'gte', left, right })),
  gt: vi.fn((left: unknown, right: unknown) => ({ op: 'gt', left, right })),
  lte: vi.fn((left: unknown, right: unknown) => ({ op: 'lte', left, right })),
  desc: vi.fn((column: unknown) => ({ op: 'desc', column })),
  isNull: vi.fn((column: unknown) => ({ op: 'isNull', column })),
  count: vi.fn(() => ({ op: 'count' })),
}))

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof DrizzleOrmModule>()
  return { ...actual, ...sqlMock }
})

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
  Object.values(sqlMock).forEach(mock => mock.mockClear())
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

  it('returns zero percentages when there are no readings', async () => {
    dbState.rowsQueue.push([])
    await expect(caller.getTrend({ hours: 1 })).resolves.toEqual({
      totalReadings: 0,
      okPercent: 0,
      lowPercent: 0,
      trend: 'unknown',
    })
  })

  it('finds level counts by name and computes exact percentages', async () => {
    dbState.rowsQueue.push([
      { level: 'low', cnt: 1 },
      { level: 'ok', cnt: 3 },
    ])
    dbState.rowsQueue.push([{ cnt: 1 }], [{ cnt: 0 }], [{ cnt: 2 }], [{ cnt: 2 }])
    const result = await caller.getTrend({ hours: 24 })
    expect(result).toMatchObject({ totalReadings: 4, okPercent: 75, lowPercent: 25 })
  })

  it('does not take the fewer-than-two shortcut at exactly two readings', async () => {
    dbState.rowsQueue.push([{ level: 'ok', cnt: 1 }, { level: 'low', cnt: 1 }])
    dbState.rowsQueue.push([{ cnt: 0 }], [{ cnt: 0 }], [{ cnt: 1 }], [{ cnt: 1 }])
    await expect(caller.getTrend({ hours: 24 })).resolves.toEqual({
      totalReadings: 2,
      okPercent: 50,
      lowPercent: 50,
      trend: 'stable',
    })
  })

  it('computes exact since and midpoint instants from hours', async () => {
    const now = new Date('2026-07-20T12:00:00Z').getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    dbState.rowsQueue.push([{ level: 'ok', cnt: 1 }])
    await caller.getTrend({ hours: 3 })
    expect(sqlMock.gte).toHaveBeenCalledWith(expect.anything(), new Date(now - 3 * 60 * 60 * 1000))

    sqlMock.gte.mockClear()
    dbState.rowsQueue.push([{ level: 'ok', cnt: 2 }])
    dbState.rowsQueue.push([{ cnt: 0 }], [{ cnt: 0 }], [{ cnt: 1 }], [{ cnt: 1 }])
    await caller.getTrend({ hours: 3 })
    expect(sqlMock.gte).toHaveBeenCalledWith(expect.anything(), new Date(now - (3 * 60 * 60 * 1000) / 2))
  })

  it('computes declining trend when recent low rate exceeds older by >0.2', async () => {
    // Order matters — totals first, then recentLow, olderLow, recentTotal, olderTotal
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 50 },
      { level: 'low', cnt: 50 },
    ])
    dbState.rowsQueue.push([{ cnt: 40 }]) // recentLow
    dbState.rowsQueue.push([{ cnt: 10 }]) // olderLow
    dbState.rowsQueue.push([{ cnt: 50 }]) // recentTotal
    dbState.rowsQueue.push([{ cnt: 50 }]) // olderTotal

    const result = await caller.getTrend({ hours: 24 })
    expect(result.trend).toBe('declining')
    expect(result.totalReadings).toBe(100)
  })

  it('computes rising trend when recent low rate is much lower than older', async () => {
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 50 },
      { level: 'low', cnt: 50 },
    ])
    dbState.rowsQueue.push([{ cnt: 10 }]) // recentLow
    dbState.rowsQueue.push([{ cnt: 40 }]) // olderLow
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
    await expect(caller.dismissAlert({ id: 999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Alert 999 not found or already dismissed',
    })
  })

  it('writes an exact dismissal timestamp and active-row predicate', async () => {
    dbState.rowsQueue.push([{ id: 5 }])
    await caller.dismissAlert({ id: 5 })
    const chain = dbMock.update.mock.results[0]?.value as {
      set: ReturnType<typeof vi.fn>
      returning: ReturnType<typeof vi.fn>
    }
    expect(chain.set).toHaveBeenCalledWith({ dismissedAt: expect.any(Date) })
    expect(chain.returning).toHaveBeenCalledOnce()
    expect(sqlMock.eq).toHaveBeenCalledWith(expect.anything(), 5)
    expect(sqlMock.isNull).toHaveBeenCalledOnce()
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

  it('uses the exact requested lookback instant and fixed row cap', async () => {
    const now = new Date('2026-07-20T12:00:00Z').getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    dbState.rowsQueue.push([])
    await caller.getFlowReadings({ hours: 6 })
    expect(sqlMock.gt).toHaveBeenCalledWith(expect.anything(), new Date(now - 6 * 60 * 60 * 1000))
    const chain = dbMock.select.mock.results[0]?.value as { limit: ReturnType<typeof vi.fn> }
    expect(chain.limit).toHaveBeenCalledWith(10080)
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

describe('waterLevel error wrappers', () => {
  it('wraps every read query DB failure as INTERNAL_SERVER_ERROR', async () => {
    const boom = new Error('db dead')
    const throwBoom = (): never => {
      throw boom
    }
    dbMock.select.mockImplementationOnce(throwBoom)
    await expect(caller.getHistory({ limit: 1 })).rejects.toThrow(/Failed to fetch water level history/)

    dbMock.select.mockImplementationOnce(throwBoom)
    await expect(caller.getLatest({})).rejects.toThrow(/Failed to fetch latest water level/)

    dbMock.select.mockImplementationOnce(throwBoom)
    await expect(caller.getTrend({ hours: 24 })).rejects.toThrow(/Failed to calculate water level trend/)

    dbMock.select.mockImplementationOnce(throwBoom)
    await expect(caller.getAlerts({})).rejects.toThrow(/Failed to fetch water level alerts/)

    dbMock.select.mockImplementationOnce(throwBoom)
    await expect(caller.getFlowReadings({ hours: 24 })).rejects.toThrow(/Failed to fetch flow readings/)

    dbMock.select.mockImplementationOnce(throwBoom)
    await expect(caller.getLatestFlowReading({})).rejects.toThrow(/Failed to fetch latest flow reading/)
  })

  it('wraps dismissAlert DB failure as INTERNAL_SERVER_ERROR', async () => {
    dbMock.update.mockImplementationOnce((): never => {
      throw new Error('update failed')
    })
    await expect(caller.dismissAlert({ id: 1 })).rejects.toThrow(/Failed to dismiss alert/)
  })

  it('uses Unknown error for non-Error failures from every procedure', async () => {
    const unknown = (): never => {
      throw { unavailable: true }
    }
    const calls: Array<[() => Promise<unknown>, string]> = [
      [() => caller.getHistory({ limit: 1 }), 'Failed to fetch water level history: Unknown error'],
      [() => caller.getLatest({}), 'Failed to fetch latest water level: Unknown error'],
      [() => caller.getTrend({ hours: 24 }), 'Failed to calculate water level trend: Unknown error'],
      [() => caller.getAlerts({}), 'Failed to fetch water level alerts: Unknown error'],
      [() => caller.getFlowReadings({ hours: 24 }), 'Failed to fetch flow readings: Unknown error'],
      [() => caller.getLatestFlowReading({}), 'Failed to fetch latest flow reading: Unknown error'],
    ]
    for (const [invoke, message] of calls) {
      dbMock.select.mockImplementationOnce(unknown)
      await expect(invoke()).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message })
    }

    dbMock.update.mockImplementationOnce(unknown)
    await expect(caller.dismissAlert({ id: 1 })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to dismiss alert: Unknown error',
    })
  })

  it('getTrend returns stable trend when totals are between thresholds', async () => {
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 60 },
      { level: 'low', cnt: 40 },
    ])
    dbState.rowsQueue.push([{ cnt: 20 }]) // recentLow
    dbState.rowsQueue.push([{ cnt: 20 }]) // olderLow
    dbState.rowsQueue.push([{ cnt: 50 }]) // recentTotal
    dbState.rowsQueue.push([{ cnt: 50 }]) // olderTotal
    const result = await caller.getTrend({ hours: 24 })
    expect(result.trend).toBe('stable')
  })

  it('getTrend keeps stable when one half has zero readings', async () => {
    dbState.rowsQueue.push([
      { level: 'ok', cnt: 5 },
      { level: 'low', cnt: 5 },
    ])
    dbState.rowsQueue.push([{ cnt: 0 }])
    dbState.rowsQueue.push([{ cnt: 0 }])
    dbState.rowsQueue.push([{ cnt: 0 }]) // recentTotal=0 — branch
    dbState.rowsQueue.push([{ cnt: 10 }])
    const result = await caller.getTrend({ hours: 24 })
    expect(result.trend).toBe('stable')
  })

  it('getTrend keeps stable when only the older half has zero readings', async () => {
    dbState.rowsQueue.push([{ level: 'ok', cnt: 5 }, { level: 'low', cnt: 5 }])
    dbState.rowsQueue.push([{ cnt: 3 }], [{ cnt: 0 }], [{ cnt: 10 }], [{ cnt: 0 }])
    expect((await caller.getTrend({ hours: 24 })).trend).toBe('stable')
  })

  it.each([
    [3, 1, 10, 10],
    [1, 3, 10, 10],
  ])('keeps stable at the exact 0.2 trend boundary %#', async (recentLow, olderLow, recentTotal, olderTotal) => {
    dbState.rowsQueue.push([{ level: 'ok', cnt: 3 }, { level: 'low', cnt: 1 }])
    dbState.rowsQueue.push([{ cnt: recentLow }], [{ cnt: olderLow }], [{ cnt: recentTotal }], [{ cnt: olderTotal }])
    expect((await caller.getTrend({ hours: 24 })).trend).toBe('stable')
  })
})
