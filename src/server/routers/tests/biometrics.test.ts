/**
 * Tests for the biometrics router. Covers happy path of every procedure
 * plus key branches: BAD_REQUEST date-range checks, NOT_FOUND for missing
 * IDs, sleep-stage fallback paths.
 *
 * biometricsDb (thenable chain + transaction), db (top-level select for
 * device timezone), raw helper, and sleep-stages classifier are mocked.
 */

import type { TRPCError } from '@trpc/server'
import type { SQL } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'

const dbState = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  txRowsQueue: [] as unknown[][],
  // Recorded chain arguments — lets tests assert the SQL that was actually
  // built (WHERE/GROUP BY/HAVING fragments, insert values, update SET maps)
  // rather than only the rows the mock hands back.
  selectFields: [] as unknown[],
  whereArgs: [] as unknown[],
  groupByArgs: [] as unknown[],
  havingArgs: [] as unknown[],
  insertValues: [] as unknown[],
  txSetValues: [] as unknown[],
  settingsRows: [{ timezone: 'America/Los_Angeles' }] as { timezone: string | null }[],
  popRows(): unknown[] { return dbState.rowsQueue.shift() ?? [] },
  popTx(): unknown[] { return dbState.txRowsQueue.shift() ?? [] },
}))

const dbMock = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.popRows()).then(resolve)
    chain.where = vi.fn((c: unknown) => {
      dbState.whereArgs.push(c)
      return chain
    })
    chain.orderBy = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.values = vi.fn((v: unknown) => {
      dbState.insertValues.push(v)
      return chain
    })
    chain.set = vi.fn(() => chain)
    chain.onConflictDoNothing = vi.fn(() => chain)
    chain.returning = vi.fn(() => chain)
    chain.groupBy = vi.fn((c: unknown) => {
      dbState.groupByArgs.push(c)
      return chain
    })
    chain.having = vi.fn((c: unknown) => {
      dbState.havingArgs.push(c)
      return chain
    })
    return chain
  }

  const makeTxChain = () => {
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.set = vi.fn((v: unknown) => {
      dbState.txSetValues.push(v)
      return chain
    })
    chain.returning = vi.fn(() => chain)
    chain.all = vi.fn(() => dbState.popTx())
    return chain
  }

  const select = vi.fn((fields?: unknown) => {
    dbState.selectFields.push(fields)

    return makeChain()
  })
  const insert = vi.fn(() => makeChain())
  const update = vi.fn(() => makeChain())
  const del = vi.fn(() => makeChain())
  const transaction = vi.fn((cb: (tx: unknown) => unknown) => cb({
    select: vi.fn(() => makeTxChain()),
    update: vi.fn(() => makeTxChain()),
  }))

  return { select, insert, update, delete: del, transaction }
})

// Top-level db mock for device settings (timezone fetch in getSleepStages default)
const topDbMock = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.settingsRows).then(resolve)
    chain.from = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    return chain
  }
  return { select: vi.fn(() => makeChain()) }
})

const rawMock = vi.hoisted(() => ({
  listRawFiles: vi.fn(async () => [] as { name: string, sizeBytes: number, modifiedAt: string }[]),
}))

const sleepStagesMock = vi.hoisted(() => ({
  classifySleepStages: vi.fn(() => [] as { start: number, duration: number, stage: 'wake' | 'light' | 'deep' | 'rem', heartRate: number | null, hrv: number | null, breathingRate: number | null, movement: number | null }[]),
  mergeIntoBlocks: vi.fn(() => [] as { start: number, end: number, stage: 'wake' | 'light' | 'deep' | 'rem' }[]),
  calculateDistribution: vi.fn(() => ({ wake: 0, light: 0, deep: 0, rem: 0 })),
  calculateQualityScore: vi.fn(() => 0),
}))

vi.mock('@/src/db', () => ({
  db: topDbMock,
  biometricsDb: dbMock,
}))

vi.mock('@/src/server/routers/raw', () => rawMock)
vi.mock('@/src/lib/sleep-stages', () => sleepStagesMock)

const occupancyMock = vi.hoisted(() => ({
  getOccupancy: vi.fn<(side: 'left' | 'right') => {
    occupied: boolean
    available: boolean
    movement: { active: boolean, peakScore: number }
    level: { active: boolean, deviation: number | null, threshold: number | null, ageMs: number | null }
  }>(() => ({
    occupied: false,
    available: false,
    movement: { active: false, peakScore: 0 },
    level: { active: false, deviation: null, threshold: null, ageMs: null },
  })),
}))
vi.mock('@/src/lib/occupancy', () => occupancyMock)

const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const caller = biometricsRouter.createCaller({})

const dialect = new SQLiteSyncDialect()

/** Render a recorded drizzle fragment to its SQL text + bound params. */
function toQuery(fragment: unknown): { sql: string, params: unknown[] } {
  const query = dialect.sqlToQuery(fragment as SQL)
  return { sql: query.sql, params: query.params }
}

/** Await a procedure expected to reject, returning the TRPCError for
 * code/message assertions (`rejects.toThrow` matches wrapped messages too). */
async function rejectionOf(promise: Promise<unknown>): Promise<TRPCError> {
  try {
    await promise
  }
  catch (error) {
    return error as TRPCError
  }
  throw new Error('expected the call to reject')
}

/** Make the next DB call throw a non-Error, exercising the 'Unknown error'
 * fallback in every catch block's message template. */
function forceNonErrorThrow(method: 'select' | 'insert' | 'update' | 'delete') {
  dbMock[method].mockImplementationOnce(() => {
    throw 'not an Error instance'
  })
}

beforeEach(() => {
  dbState.rowsQueue.length = 0
  dbState.txRowsQueue.length = 0
  dbState.selectFields.length = 0
  dbState.whereArgs.length = 0
  dbState.groupByArgs.length = 0
  dbState.havingArgs.length = 0
  dbState.insertValues.length = 0
  dbState.txSetValues.length = 0
  dbState.settingsRows = [{ timezone: 'America/Los_Angeles' }]
  dbMock.select.mockClear()
  dbMock.insert.mockClear()
  dbMock.update.mockClear()
  dbMock.delete.mockClear()
  dbMock.transaction.mockClear()
  topDbMock.select.mockClear()
  rawMock.listRawFiles.mockReset().mockResolvedValue([])
  sleepStagesMock.classifySleepStages.mockReset().mockReturnValue([])
  sleepStagesMock.mergeIntoBlocks.mockReset().mockReturnValue([])
  sleepStagesMock.calculateDistribution.mockReset().mockReturnValue({ wake: 0, light: 0, deep: 0, rem: 0 })
  sleepStagesMock.calculateQualityScore.mockReset().mockReturnValue(0)
  occupancyMock.getOccupancy.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('biometrics.getSleepRecords', () => {
  it('returns rows', async () => {
    dbState.rowsQueue.push([
      {
        id: 1, side: 'left', enteredBedAt: new Date(0), leftBedAt: new Date(1000),
        sleepDurationSeconds: 1, timesExitedBed: 0,
        presentIntervals: null, notPresentIntervals: null, createdAt: new Date(0),
      },
    ])
    const out = await caller.getSleepRecords({ limit: 10 })
    expect(out).toHaveLength(1)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getSleepRecords({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate/)
  })
})

describe('biometrics.getVitals', () => {
  it('returns rows', async () => {
    dbState.rowsQueue.push([
      { id: 1, side: 'left', timestamp: new Date(0), heartRate: 60, hrv: 50, breathingRate: 14 },
    ])
    const out = await caller.getVitals({ limit: 10 })
    expect(out).toHaveLength(1)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getVitals({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate/)
  })
})

describe('biometrics.getMovement / getMovementBuckets / getMovementSummary', () => {
  it('getMovement returns rows', async () => {
    dbState.rowsQueue.push([{ id: 1, side: 'left', timestamp: new Date(0), totalMovement: 100 }])
    const out = await caller.getMovement({ limit: 10 })
    expect(out).toHaveLength(1)
  })

  it('getMovement rejects inverted date range', async () => {
    await expect(caller.getMovement({
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
      limit: 10,
    })).rejects.toThrow(/startDate/)
  })

  it('getMovementBuckets coerces SQL bucketStart to a Date', async () => {
    dbState.rowsQueue.push([
      { bucketStart: 1700000, totalMovement: 250, eventCount: 1, sampleCount: 5 },
    ])
    const out = await caller.getMovementBuckets({ side: 'left', bucketSeconds: 60, limit: 100 })
    expect(out).toHaveLength(1)
    expect(out[0].bucketStart).toBeInstanceOf(Date)
    expect(out[0].totalMovement).toBe(250)
  })

  it('getMovementBuckets rejects inverted date range', async () => {
    await expect(caller.getMovementBuckets({
      side: 'left', bucketSeconds: 60, limit: 10,
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    })).rejects.toThrow(/startDate/)
  })

  it('getMovementSummary aggregates row to numbers', async () => {
    dbState.rowsQueue.push([{ positionChanges: '4', restlessMinutes: '20', sampleCount: '60' }])
    const out = await caller.getMovementSummary({ side: 'left' })
    expect(out).toEqual({ positionChanges: 4, restlessMinutes: 20, sampleCount: 60 })
  })

  it('getMovementSummary handles empty result', async () => {
    dbState.rowsQueue.push([])
    const out = await caller.getMovementSummary({ side: 'left' })
    expect(out).toEqual({ positionChanges: 0, restlessMinutes: 0, sampleCount: 0 })
  })
})

describe('biometrics.getLatestSleep', () => {
  it('returns null when no record', async () => {
    dbState.rowsQueue.push([])
    const out = await caller.getLatestSleep({ side: 'left' })
    expect(out).toBeNull()
  })

  it('returns latest record when present', async () => {
    dbState.rowsQueue.push([
      { id: 5, side: 'left', enteredBedAt: new Date(0), leftBedAt: null,
        sleepDurationSeconds: 0, timesExitedBed: 0,
        presentIntervals: null, notPresentIntervals: null, createdAt: new Date(0) },
    ])
    const out = await caller.getLatestSleep({ side: 'left' })
    expect(out?.id).toBe(5)
  })
})

describe('biometrics.getOccupancy', () => {
  it('returns occupancy for both sides from the shared virtual sensor', async () => {
    occupancyMock.getOccupancy.mockImplementation((side: 'left' | 'right') => ({
      occupied: side === 'left',
      available: false,
      movement: { active: side === 'left', peakScore: side === 'left' ? 300 : 10 },
      level: { active: false, deviation: null, threshold: null, ageMs: null },
    }))
    const out = await caller.getOccupancy()
    expect(out.left.occupied).toBe(true)
    expect(out.left.movement.peakScore).toBe(300)
    expect(out.right.occupied).toBe(false)
    expect(occupancyMock.getOccupancy).toHaveBeenCalledWith('left')
    expect(occupancyMock.getOccupancy).toHaveBeenCalledWith('right')
  })

  it('passes level signal through to the response', async () => {
    occupancyMock.getOccupancy.mockReturnValue({
      occupied: true,
      available: true,
      movement: { active: false, peakScore: 5 },
      level: { active: true, deviation: 12.3, threshold: 6, ageMs: 500 },
    })
    const out = await caller.getOccupancy()
    expect(out.left.available).toBe(true)
    expect(out.left.level.deviation).toBe(12.3)
    expect(out.left.level.threshold).toBe(6)
    expect(out.left.level.ageMs).toBe(500)
    expect(out.left.level.active).toBe(true)
  })
})

describe('biometrics.getVitalsSummary', () => {
  it('returns null when recordCount=0', async () => {
    dbState.rowsQueue.push([{
      avgHeartRate: null, minHeartRate: null, maxHeartRate: null,
      avgHRV: null, avgBreathingRate: null, recordCount: 0,
    }])
    const out = await caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out).toBeNull()
  })

  it('returns aggregated stats when records present', async () => {
    dbState.rowsQueue.push([{
      avgHeartRate: '60', minHeartRate: 50, maxHeartRate: 80,
      avgHRV: '40', avgBreathingRate: '14', recordCount: 10,
    }])
    const out = await caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out?.avgHeartRate).toBe(60)
    expect(out?.recordCount).toBe(10)
  })

  it('rejects inverted date range', async () => {
    await expect(caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    })).rejects.toThrow(/startDate/)
  })
})

describe('biometrics.getVitalsBaseline', () => {
  it('returns null when sampleCount=0', async () => {
    dbState.rowsQueue.push([{
      hrMean: null, hrSqMean: null,
      hrvMean: null, hrvSqMean: null,
      brMean: null, brSqMean: null,
      sampleCount: 0,
    }])
    const out = await caller.getVitalsBaseline({ side: 'left', days: 30 })
    expect(out).toBeNull()
  })

  it('computes mean and SD via E[X²] − E[X]² when variance > 0', async () => {
    // hr: mean=60, sqMean=3604 → variance=4 → SD=2
    // hrv: mean=50, sqMean=2509 → variance=9 → SD=3
    // br: mean=14, sqMean=200 → variance=4 → SD=2
    dbState.rowsQueue.push([{
      hrMean: '60', hrSqMean: '3604',
      hrvMean: '50', hrvSqMean: '2509',
      brMean: '14', brSqMean: '200',
      sampleCount: 100,
    }])
    const out = await caller.getVitalsBaseline({ side: 'left', days: 30 })
    expect(out).toEqual({
      hrMean: 60, hrSD: 2,
      hrvMean: 50, hrvSD: 3,
      brMean: 14, brSD: 2,
      sampleCount: 100,
      windowDays: 30,
    })
  })

  it('returns SD=0 when variance is non-positive (single sample / no spread)', async () => {
    // mean=60, sqMean=3600 → variance=0 → SD=0
    dbState.rowsQueue.push([{
      hrMean: '60', hrSqMean: '3600',
      hrvMean: '50', hrvSqMean: '2500',
      brMean: '14', brSqMean: '196',
      sampleCount: 1,
    }])
    const out = await caller.getVitalsBaseline({ side: 'left', days: 30 })
    expect(out?.hrSD).toBe(0)
    expect(out?.hrvSD).toBe(0)
    expect(out?.brSD).toBe(0)
  })

  it('returns null SD for metrics whose mean or sqMean is null', async () => {
    // hr present, hrv mean null, br sqMean null
    dbState.rowsQueue.push([{
      hrMean: '60', hrSqMean: '3604',
      hrvMean: null, hrvSqMean: '2509',
      brMean: '14', brSqMean: null,
      sampleCount: 50,
    }])
    const out = await caller.getVitalsBaseline({ side: 'left', days: 30 })
    expect(out?.hrMean).toBe(60)
    expect(out?.hrSD).toBe(2)
    expect(out?.hrvMean).toBeNull()
    expect(out?.hrvSD).toBeNull()
    expect(out?.brMean).toBe(14)
    expect(out?.brSD).toBeNull()
  })

  it('echoes the requested days as windowDays (custom window)', async () => {
    dbState.rowsQueue.push([{
      hrMean: '60', hrSqMean: '3604',
      hrvMean: null, hrvSqMean: null,
      brMean: null, brSqMean: null,
      sampleCount: 5,
    }])
    const out = await caller.getVitalsBaseline({ side: 'right', days: 7 })
    expect(out?.windowDays).toBe(7)
    expect(out?.sampleCount).toBe(5)
  })

  it('wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    dbMock.select.mockImplementationOnce(() => {
      throw new Error('db blew up')
    })
    await expect(caller.getVitalsBaseline({ side: 'left', days: 30 }))
      .rejects.toThrow(/Failed to calculate vitals baseline: db blew up/)
  })
})

describe('biometrics.reportVitals / reportVitalsBatch', () => {
  it('reportVitals returns written:1', async () => {
    const out = await caller.reportVitals({
      side: 'left',
      timestamp: 1700000000,
      heartRate: 60, hrv: 50, breathingRate: 14,
    })
    expect(out).toEqual({ written: 1 })
  })

  it('reportVitalsBatch returns the count of inserted rows', async () => {
    // The chain await resolves to whatever popRows returns from .returning()
    dbState.rowsQueue.push([{ id: 1 }, { id: 2 }])
    const out = await caller.reportVitalsBatch({
      vitals: [
        { side: 'left', timestamp: 1700000000, heartRate: 60, hrv: 50, breathingRate: 14 },
        { side: 'left', timestamp: 1700000300, heartRate: 61, hrv: 51, breathingRate: 14 },
      ],
    })
    expect(out).toEqual({ written: 2 })
  })
})

describe('biometrics.getFileCount', () => {
  it('aggregates raw file count and total MB', async () => {
    rawMock.listRawFiles.mockResolvedValue([
      { name: 'a.RAW', sizeBytes: 1024 * 1024, modifiedAt: 'x' },
      { name: 'b.RAW', sizeBytes: 2 * 1024 * 1024, modifiedAt: 'y' },
    ])
    const out = await caller.getFileCount({})
    expect(out.rawFiles).toEqual({ left: 2, right: 2 })
    expect(out.totalSizeMB).toBe(3)
  })

  it('returns zeros on listRawFiles error', async () => {
    rawMock.listRawFiles.mockRejectedValue(new Error('ENOENT'))
    const out = await caller.getFileCount({})
    expect(out).toEqual({ rawFiles: { left: 0, right: 0 }, totalSizeMB: 0 })
  })
})

describe('biometrics.updateSleepRecord', () => {
  it('rejects when no fields supplied', async () => {
    await expect(caller.updateSleepRecord({ id: 1 })).rejects.toThrow(/No fields to update/)
  })

  it('throws NOT_FOUND when record missing during recompute', async () => {
    dbState.txRowsQueue.push([])
    await expect(caller.updateSleepRecord({
      id: 1,
      enteredBedAt: new Date('2025-01-01T00:00:00Z'),
    })).rejects.toThrow(/Sleep record 1 not found/)
  })

  it('rejects leftBedAt at or before enteredBedAt', async () => {
    dbState.txRowsQueue.push([
      { id: 1, side: 'left', enteredBedAt: new Date('2025-01-01T00:00:00Z'), leftBedAt: new Date('2025-01-01T08:00:00Z') },
    ])
    await expect(caller.updateSleepRecord({
      id: 1,
      enteredBedAt: new Date('2025-01-01T10:00:00Z'),
    })).rejects.toThrow(/leftBedAt must be after enteredBedAt/)
  })

  it('updates timesExitedBed when only it is provided (skips duration recompute)', async () => {
    const updated = {
      id: 1, side: 'left',
      enteredBedAt: new Date(0), leftBedAt: new Date(1000),
      sleepDurationSeconds: 1, timesExitedBed: 7,
      presentIntervals: null, notPresentIntervals: null, createdAt: new Date(0),
    }
    dbState.txRowsQueue.push([updated])
    const out = await caller.updateSleepRecord({ id: 1, timesExitedBed: 7 })
    expect(out.timesExitedBed).toBe(7)
  })
})

describe('biometrics.deleteSleepRecord', () => {
  it('returns success when a row was deleted', async () => {
    dbState.rowsQueue.push([{ id: 1 }])
    const out = await caller.deleteSleepRecord({ id: 1 })
    expect(out).toEqual({ success: true })
  })

  it('throws NOT_FOUND when nothing was deleted', async () => {
    dbState.rowsQueue.push([])
    await expect(caller.deleteSleepRecord({ id: 99 })).rejects.toThrow(/Sleep record 99 not found/)
  })
})

describe('biometrics.getSleepStages', () => {
  it('rejects when both sleepRecordId and date range are provided', async () => {
    await expect(caller.getSleepStages({
      side: 'left',
      sleepRecordId: 1,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Provide either sleepRecordId or startDate/)
  })

  it('throws NOT_FOUND when sleepRecordId missing', async () => {
    dbState.rowsQueue.push([])
    await expect(caller.getSleepStages({ side: 'left', sleepRecordId: 99 })).rejects.toThrow(/Sleep record 99 not found/)
  })

  it('returns empty result when no recent records exist (default branch)', async () => {
    // Recent records query returns []
    dbState.rowsQueue.push([])
    const out = await caller.getSleepStages({ side: 'left' })
    expect(out.epochs).toEqual([])
    expect(out.sleepRecordId).toBeNull()
  })

  it('classifies stages from a sleepRecordId-supplied window', async () => {
    const record = {
      id: 1, side: 'left',
      enteredBedAt: new Date('2025-01-01T22:00:00Z'),
      leftBedAt: new Date('2025-01-02T07:00:00Z'),
    }
    // Three queries: record lookup, vitals window, movement window
    dbState.rowsQueue.push([record])
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(), heartRate: 60, hrv: 50, breathingRate: 14 }])
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(), totalMovement: 100 }])

    sleepStagesMock.classifySleepStages.mockReturnValue([
      { start: 0, duration: 300_000, stage: 'light', heartRate: 60, hrv: 50, breathingRate: 14, movement: 100 },
    ])
    sleepStagesMock.mergeIntoBlocks.mockReturnValue([{ start: 0, end: 300_000, stage: 'light' }])
    sleepStagesMock.calculateDistribution.mockReturnValue({ wake: 0, light: 1, deep: 0, rem: 0 })
    sleepStagesMock.calculateQualityScore.mockReturnValue(80)

    const out = await caller.getSleepStages({ side: 'left', sleepRecordId: 1 })
    expect(out.sleepRecordId).toBe(1)
    expect(out.epochs).toHaveLength(1)
    expect(out.qualityScore).toBe(80)
    expect(out.totalSleepMs).toBe(300_000)
  })

  it('rejects an inverted custom date range', async () => {
    await expect(caller.getSleepStages({
      side: 'left',
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    })).rejects.toThrow(/startDate/)
  })

  it('uses current time as windowEnd for active sleep sessions (leftBedAt=null)', async () => {
    const record = {
      id: 7, side: 'left',
      enteredBedAt: new Date('2025-01-01T22:00:00Z'),
      leftBedAt: null, // active session
    }
    dbState.rowsQueue.push([record])
    dbState.rowsQueue.push([]) // vitals empty
    dbState.rowsQueue.push([]) // movement empty
    const out = await caller.getSleepStages({ side: 'left', sleepRecordId: 7 })
    expect(out.sleepRecordId).toBe(7)
    expect(out.leftBedAt).toBeNull()
    expect(out.enteredBedAt).toBe(record.enteredBedAt.getTime())
  })

  it('classifies stages from a custom date-range window', async () => {
    // No record lookup: vitals + movement queries only
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(), heartRate: 60, hrv: 50, breathingRate: 14 }])
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(), totalMovement: 50 }])

    sleepStagesMock.classifySleepStages.mockReturnValue([
      { start: 0, duration: 600_000, stage: 'deep', heartRate: 55, hrv: 60, breathingRate: 12, movement: 10 },
    ])
    sleepStagesMock.mergeIntoBlocks.mockReturnValue([{ start: 0, end: 600_000, stage: 'deep' }])
    sleepStagesMock.calculateDistribution.mockReturnValue({ wake: 0, light: 0, deep: 1, rem: 0 })
    sleepStagesMock.calculateQualityScore.mockReturnValue(90)

    const out = await caller.getSleepStages({
      side: 'left',
      startDate: new Date('2025-01-01T22:00:00Z'),
      endDate: new Date('2025-01-02T06:00:00Z'),
    })
    expect(out.sleepRecordId).toBeNull()
    expect(out.enteredBedAt).toBeNull()
    expect(out.leftBedAt).toBeNull()
    expect(out.epochs).toHaveLength(1)
    expect(out.qualityScore).toBe(90)
  })

  it('returns empty stages result when classifier yields no epochs (default path)', async () => {
    // Default branch with a record found: hits localHour + overnight finder, then empty-epoch return
    const enteredAt = new Date()
    enteredAt.setHours(22, 0, 0, 0) // 10pm local — qualifies as overnight (>=20)
    const record = {
      id: 9, side: 'left',
      enteredBedAt: enteredAt,
      leftBedAt: new Date(enteredAt.getTime() + 8 * 60 * 60 * 1000),
      sleepDurationSeconds: 8 * 60 * 60,
    }
    dbState.rowsQueue.push([record]) // recent records
    dbState.rowsQueue.push([]) // vitals empty
    dbState.rowsQueue.push([]) // movement empty
    sleepStagesMock.classifySleepStages.mockReturnValue([])

    const out = await caller.getSleepStages({ side: 'left' })
    expect(out.epochs).toEqual([])
    expect(out.sleepRecordId).toBe(9)
    expect(out.qualityScore).toBe(0)
  })

  it('falls back to longest record in last 24h when no overnight session matches', async () => {
    // Two daytime naps within 24h — neither qualifies as "overnight" (8pm-4am local)
    // and one is shorter than 3h. So overnightRecord = undefined, last24h reduce picks longest.
    const noon = new Date()
    noon.setHours(12, 0, 0, 0)
    const shortNap = {
      id: 11, side: 'left',
      enteredBedAt: noon,
      leftBedAt: new Date(noon.getTime() + 30 * 60 * 1000),
      sleepDurationSeconds: 30 * 60,
    }
    const longerNap = {
      id: 12, side: 'left',
      enteredBedAt: new Date(noon.getTime() + 2 * 60 * 60 * 1000),
      leftBedAt: new Date(noon.getTime() + 4 * 60 * 60 * 1000),
      sleepDurationSeconds: 2 * 60 * 60,
    }
    dbState.rowsQueue.push([shortNap, longerNap])
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(), heartRate: 60, hrv: 50, breathingRate: 14 }])
    dbState.rowsQueue.push([{ id: 1, timestamp: new Date(), totalMovement: 50 }])

    sleepStagesMock.classifySleepStages.mockReturnValue([
      { start: 0, duration: 1000, stage: 'light', heartRate: 60, hrv: 50, breathingRate: 14, movement: 10 },
    ])

    const out = await caller.getSleepStages({ side: 'left' })
    // longerNap (2h) > shortNap (30min), so longerNap wins via reduce
    expect(out.sleepRecordId).toBe(12)
  })

  it('falls back to most recent record (>24h old) when no overnight or 24h record qualifies', async () => {
    // Record older than 24h ago — fails both overnight check (daytime) and 24h filter.
    // Falls through to recentRecords[0].
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    twoDaysAgo.setHours(12, 0, 0, 0) // noon local — not overnight
    const oldNap = {
      id: 13, side: 'left',
      enteredBedAt: twoDaysAgo,
      leftBedAt: new Date(twoDaysAgo.getTime() + 30 * 60 * 1000),
      sleepDurationSeconds: 30 * 60,
    }
    dbState.rowsQueue.push([oldNap])
    dbState.rowsQueue.push([])
    dbState.rowsQueue.push([])
    sleepStagesMock.classifySleepStages.mockReturnValue([])

    const out = await caller.getSleepStages({ side: 'left' })
    expect(out.sleepRecordId).toBe(13)
  })

  it('wraps unexpected errors as INTERNAL_SERVER_ERROR', async () => {
    // Cause classifySleepStages to throw — must be wrapped, not bubbled raw.
    const record = {
      id: 1, side: 'left',
      enteredBedAt: new Date('2025-01-01T22:00:00Z'),
      leftBedAt: new Date('2025-01-02T07:00:00Z'),
    }
    dbState.rowsQueue.push([record])
    dbState.rowsQueue.push([])
    dbState.rowsQueue.push([])
    sleepStagesMock.classifySleepStages.mockImplementation(() => {
      throw new Error('boom')
    })
    await expect(caller.getSleepStages({ side: 'left', sleepRecordId: 1 }))
      .rejects.toThrow(/Failed to classify sleep stages.*boom/)
  })
})

describe('biometrics filter combinations (side + startDate + endDate)', () => {
  // These cover the per-filter conditions.push(...) branches that single-filter
  // cases miss.
  it('getSleepRecords applies all three filters', async () => {
    dbState.rowsQueue.push([])
    await caller.getSleepRecords({
      side: 'right',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31'),
      limit: 5,
    })
    expect(dbMock.select).toHaveBeenCalled()
  })

  it('getVitals applies all three filters', async () => {
    dbState.rowsQueue.push([])
    await caller.getVitals({
      side: 'right',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
      limit: 5,
    })
    expect(dbMock.select).toHaveBeenCalled()
  })

  it('getMovement applies all three filters', async () => {
    dbState.rowsQueue.push([])
    await caller.getMovement({
      side: 'right',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
      limit: 5,
    })
    expect(dbMock.select).toHaveBeenCalled()
  })

  it('getMovementBuckets applies startDate and endDate', async () => {
    dbState.rowsQueue.push([])
    const out = await caller.getMovementBuckets({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
      bucketSeconds: 300,
      limit: 100,
    })
    expect(out).toEqual([])
  })

  it('getMovementBuckets coerces null SQL aggregates to zero', async () => {
    dbState.rowsQueue.push([
      { bucketStart: 1700000, totalMovement: null, eventCount: null, sampleCount: null },
    ])
    const out = await caller.getMovementBuckets({ side: 'left', bucketSeconds: 60, limit: 10 })
    expect(out[0].totalMovement).toBe(0)
    expect(out[0].eventCount).toBe(0)
    expect(out[0].sampleCount).toBe(0)
  })

  it('getMovementSummary applies startDate and endDate', async () => {
    dbState.rowsQueue.push([{ positionChanges: 1, restlessMinutes: 2, sampleCount: 3 }])
    const out = await caller.getMovementSummary({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out.positionChanges).toBe(1)
  })

  it('getMovementSummary rejects inverted date range', async () => {
    await expect(caller.getMovementSummary({
      side: 'left',
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    })).rejects.toThrow(/startDate/)
  })
})

describe('biometrics getVitalsSummary edge cases', () => {
  it('returns null-typed aggregates when SQL avgs are null but recordCount > 0', async () => {
    // Edge case: COUNT(*) > 0 but all heart-rate columns are NULL.
    dbState.rowsQueue.push([{
      avgHeartRate: null, minHeartRate: null, maxHeartRate: null,
      avgHRV: null, avgBreathingRate: null, recordCount: 3,
    }])
    const out = await caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out).toEqual({
      avgHeartRate: null, minHeartRate: null, maxHeartRate: null,
      avgHRV: null, avgBreathingRate: null, recordCount: 3,
    })
  })

  it('uses default 7-day window when startDate/endDate not provided', async () => {
    dbState.rowsQueue.push([{
      avgHeartRate: '60', minHeartRate: 50, maxHeartRate: 80,
      avgHRV: '40', avgBreathingRate: '14', recordCount: 5,
    }])
    const out = await caller.getVitalsSummary({ side: 'left' })
    expect(out?.recordCount).toBe(5)
  })

  it('rejects when endDate-only is older than the default 7-day window start', async () => {
    // No startDate → defaults to now-7d. endDate set to 30 days ago →
    // effectiveStart > effectiveEnd, triggering the computed-inverted guard.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await expect(caller.getVitalsSummary({
      side: 'left',
      endDate: thirtyDaysAgo,
    })).rejects.toThrow(/Computed date range is inverted/)
  })
})

describe('biometrics updateSleepRecord happy paths', () => {
  it('recalculates duration when both timestamps are supplied', async () => {
    const entered = new Date('2025-01-01T22:00:00Z')
    const left = new Date('2025-01-02T06:00:00Z')
    // tx.select returns existing record (so the inner branch fires)
    dbState.txRowsQueue.push([
      { id: 1, side: 'left', enteredBedAt: entered, leftBedAt: left },
    ])
    // tx.update returns updated row
    dbState.txRowsQueue.push([
      {
        id: 1, side: 'left',
        enteredBedAt: entered, leftBedAt: left,
        sleepDurationSeconds: 8 * 3600, timesExitedBed: 0,
        presentIntervals: null, notPresentIntervals: null, createdAt: new Date(0),
      },
    ])
    const out = await caller.updateSleepRecord({
      id: 1,
      enteredBedAt: entered,
      leftBedAt: left,
    })
    expect(out.sleepDurationSeconds).toBe(8 * 3600)
  })

  it('throws NOT_FOUND when update returns no row (timesExitedBed-only path)', async () => {
    // Skips the recompute branch (no enteredBedAt/leftBedAt). tx.update returns [].
    dbState.txRowsQueue.push([])
    await expect(caller.updateSleepRecord({ id: 99, timesExitedBed: 3 }))
      .rejects.toThrow(/Sleep record 99 not found/)
  })
})

describe('biometrics error wrapping (INTERNAL_SERVER_ERROR catches)', () => {
  // Cover the catch(error) branches in each procedure. We force the DB chain
  // to throw by making `.where()` (or another late chain method) reject.
  function forceDbError(method: 'select' | 'insert' | 'update' | 'delete') {
    const failingChain = {
      then: (resolve: unknown, reject: (err: Error) => unknown) =>
        Promise.reject(new Error('db down')).catch(reject),
      where: vi.fn(() => failingChain),
      orderBy: vi.fn(() => failingChain),
      limit: vi.fn(() => failingChain),
      from: vi.fn(() => failingChain),
      values: vi.fn(() => failingChain),
      set: vi.fn(() => failingChain),
      onConflictDoNothing: vi.fn(() => failingChain),
      returning: vi.fn(() => failingChain),
      groupBy: vi.fn(() => failingChain),
      having: vi.fn(() => failingChain),
    }
    dbMock[method].mockImplementationOnce(() => failingChain)
  }

  it('getSleepRecords wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getSleepRecords({ limit: 5 }))
      .rejects.toThrow(/Failed to fetch sleep records.*db down/)
  })

  it('getVitals wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getVitals({ limit: 5 }))
      .rejects.toThrow(/Failed to fetch vitals.*db down/)
  })

  it('getMovement wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getMovement({ limit: 5 }))
      .rejects.toThrow(/Failed to fetch movement data.*db down/)
  })

  it('getMovementBuckets wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getMovementBuckets({ side: 'left', bucketSeconds: 60, limit: 10 }))
      .rejects.toThrow(/Failed to fetch movement buckets.*db down/)
  })

  it('getMovementSummary wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getMovementSummary({ side: 'left' }))
      .rejects.toThrow(/Failed to fetch movement summary.*db down/)
  })

  it('getLatestSleep wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getLatestSleep({ side: 'left' }))
      .rejects.toThrow(/Failed to fetch latest sleep record.*db down/)
  })

  it('getVitalsSummary wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('select')
    await expect(caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })).rejects.toThrow(/Failed to calculate vitals summary.*db down/)
  })

  it('reportVitals wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('insert')
    await expect(caller.reportVitals({
      side: 'left', timestamp: 1700000000,
      heartRate: 60, hrv: 50, breathingRate: 14,
    })).rejects.toThrow(/Failed to report vitals.*db down/)
  })

  it('reportVitalsBatch wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    forceDbError('insert')
    await expect(caller.reportVitalsBatch({
      vitals: [{ side: 'left', timestamp: 1700000000, heartRate: 60, hrv: 50, breathingRate: 14 }],
    })).rejects.toThrow(/Failed to report vitals batch.*db down/)
  })
})

describe('biometrics WHERE/SELECT fragment construction', () => {
  it('getSleepRecords pushes one condition per supplied filter', async () => {
    dbState.rowsQueue.push([])
    await caller.getSleepRecords({
      side: 'right',
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-01-31T00:00:00Z'),
      limit: 5,
    })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.sql).toBe('("sleep_records"."side" = ? and "sleep_records"."entered_bed_at" >= ? and "sleep_records"."entered_bed_at" <= ?)')
    expect(query.params).toEqual(['right', 1735689600, 1738281600])
  })

  it('getSleepRecords passes an undefined WHERE when no filter is supplied', async () => {
    dbState.rowsQueue.push([])
    await caller.getSleepRecords({ limit: 5 })
    expect(dbState.whereArgs[0]).toBeUndefined()
  })

  it('getVitals pushes one condition per supplied filter', async () => {
    dbState.rowsQueue.push([])
    await caller.getVitals({
      side: 'right',
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-01-02T00:00:00Z'),
      limit: 5,
    })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.sql).toBe('("vitals"."side" = ? and "vitals"."timestamp" >= ? and "vitals"."timestamp" <= ?)')
    expect(query.params).toEqual(['right', 1735689600, 1735776000])
  })

  it('getVitals passes an undefined WHERE when no filter is supplied', async () => {
    dbState.rowsQueue.push([])
    await caller.getVitals({ limit: 5 })
    expect(dbState.whereArgs[0]).toBeUndefined()
  })

  it('getMovement pushes one condition per supplied filter', async () => {
    dbState.rowsQueue.push([])
    await caller.getMovement({
      side: 'right',
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-01-02T00:00:00Z'),
      limit: 5,
    })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.sql).toBe('("movement"."side" = ? and "movement"."timestamp" >= ? and "movement"."timestamp" <= ?)')
    expect(query.params).toEqual(['right', 1735689600, 1735776000])
  })

  it('getMovement passes an undefined WHERE when no filter is supplied', async () => {
    dbState.rowsQueue.push([])
    await caller.getMovement({ limit: 5 })
    expect(dbState.whereArgs[0]).toBeUndefined()
  })

  it('getMovementBuckets restricts to the side and to recorded in-bed windows', async () => {
    dbState.rowsQueue.push([])
    await caller.getMovementBuckets({
      side: 'right',
      startDate: new Date('2025-01-01T00:00:00Z'),
      endDate: new Date('2025-01-02T00:00:00Z'),
      bucketSeconds: 300,
      limit: 100,
    })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.sql).toContain('"movement"."side" = ?')
    expect(query.sql).toContain('EXISTS (')
    expect(query.sql).toContain('SELECT 1 FROM "sleep_records"')
    expect(query.sql).toContain('"sleep_records"."side" = ?')
    expect(query.sql).toContain('"movement"."timestamp" >= "sleep_records"."entered_bed_at"')
    expect(query.sql).toContain('"movement"."timestamp" <= COALESCE("sleep_records"."left_bed_at", 99999999999)')
    expect(query.sql).toContain('"movement"."timestamp" >= ?')
    expect(query.sql).toContain('"movement"."timestamp" <= ?')
    expect(query.params).toEqual(['right', 'right', 1735689600, 1735776000])
  })

  it('getMovementBuckets inlines bucket width and thresholds into the SQL', async () => {
    dbState.rowsQueue.push([])
    await caller.getMovementBuckets({ side: 'left', bucketSeconds: 1800, limit: 100 })
    const fields = dbState.selectFields[0] as Record<string, unknown>
    expect(toQuery(fields.bucketStart).sql).toBe('("movement"."timestamp" / 1800) * 1800')
    expect(toQuery(fields.totalMovement).sql).toBe('SUM("movement"."total_movement")')
    expect(toQuery(fields.eventCount).sql).toBe('COUNT(CASE WHEN "movement"."total_movement" >= 200 THEN 1 END)')
    expect(toQuery(dbState.groupByArgs[0]).sql).toBe('("movement"."timestamp" / 1800) * 1800')
    // pickMinBucketNonStillEpochs(1800) === 3
    expect(toQuery(dbState.havingArgs[0]).sql).toBe('SUM(CASE WHEN "movement"."total_movement" >= 50 THEN 1 ELSE 0 END) >= 3')
  })

  it('getMovementSummary restricts to the side and to recorded in-bed windows', async () => {
    dbState.rowsQueue.push([{ positionChanges: 0, restlessMinutes: 0, sampleCount: 0 }])
    await caller.getMovementSummary({ side: 'left' })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.sql).toContain('"movement"."side" = ?')
    expect(query.sql).toContain('EXISTS (')
    expect(query.sql).toContain('"movement"."timestamp" <= COALESCE("sleep_records"."left_bed_at", 99999999999)')
    expect(query.params).toEqual(['left', 'left'])
  })

  it('getMovementSummary counts position changes and restless minutes at their thresholds', async () => {
    dbState.rowsQueue.push([{ positionChanges: 0, restlessMinutes: 0, sampleCount: 0 }])
    await caller.getMovementSummary({ side: 'left' })
    const fields = dbState.selectFields[0] as Record<string, unknown>
    expect(toQuery(fields.positionChanges).sql).toBe('COUNT(CASE WHEN "movement"."total_movement" >= 200 THEN 1 END)')
    expect(toQuery(fields.restlessMinutes).sql).toBe('COUNT(CASE WHEN "movement"."total_movement" >= 50 THEN 1 END)')
  })
})

describe('biometrics BAD_REQUEST guards keep their code and message', () => {
  it('getMovementBuckets rethrows the TRPCError untouched', async () => {
    const error = await rejectionOf(caller.getMovementBuckets({
      side: 'left', bucketSeconds: 60, limit: 10,
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    }))
    expect(error.code).toBe('BAD_REQUEST')
    expect(error.message).toBe('startDate must be before or equal to endDate')
  })

  it('getMovementSummary rethrows the TRPCError untouched', async () => {
    const error = await rejectionOf(caller.getMovementSummary({
      side: 'left',
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    }))
    expect(error.code).toBe('BAD_REQUEST')
    expect(error.message).toBe('startDate must be before or equal to endDate')
  })

  it('getSleepStages rethrows the TRPCError untouched', async () => {
    const error = await rejectionOf(caller.getSleepStages({
      side: 'left',
      sleepRecordId: 1,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    }))
    expect(error.code).toBe('BAD_REQUEST')
    expect(error.message).toBe('Provide either sleepRecordId or startDate/endDate, not both')
  })

  it('getSleepStages rejects sleepRecordId combined with startDate alone', async () => {
    const error = await rejectionOf(caller.getSleepStages({
      side: 'left',
      sleepRecordId: 1,
      startDate: new Date('2025-01-01'),
    }))
    expect(error.message).toBe('Provide either sleepRecordId or startDate/endDate, not both')
  })

  it('getSleepStages rejects sleepRecordId combined with endDate alone', async () => {
    const error = await rejectionOf(caller.getSleepStages({
      side: 'left',
      sleepRecordId: 1,
      endDate: new Date('2025-01-02'),
    }))
    expect(error.message).toBe('Provide either sleepRecordId or startDate/endDate, not both')
  })

  it('getVitalsSummary reports the explicit-range failure, not the computed-range one', async () => {
    // This catch block re-wraps its own BAD_REQUEST, so only the inner text
    // distinguishes the explicit guard from the computed-range guard below it.
    const error = await rejectionOf(caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-01-01'),
    }))
    expect(error.message).toBe('Failed to calculate vitals summary: startDate must be before or equal to endDate')
  })
})

describe('biometrics catch blocks fall back to \'Unknown error\' for non-Error throws', () => {
  it('getSleepRecords', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getSleepRecords({ limit: 5 }))
    expect(error.message).toBe('Failed to fetch sleep records: Unknown error')
  })

  it('getVitals', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getVitals({ limit: 5 }))
    expect(error.message).toBe('Failed to fetch vitals: Unknown error')
  })

  it('getMovement', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getMovement({ limit: 5 }))
    expect(error.message).toBe('Failed to fetch movement data: Unknown error')
  })

  it('getMovementBuckets', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getMovementBuckets({ side: 'left', bucketSeconds: 60, limit: 10 }))
    expect(error.message).toBe('Failed to fetch movement buckets: Unknown error')
  })

  it('getMovementSummary', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getMovementSummary({ side: 'left' }))
    expect(error.message).toBe('Failed to fetch movement summary: Unknown error')
  })

  it('getLatestSleep', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getLatestSleep({ side: 'left' }))
    expect(error.message).toBe('Failed to fetch latest sleep record: Unknown error')
  })

  it('getVitalsSummary', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getVitalsSummary({ side: 'left' }))
    expect(error.message).toBe('Failed to calculate vitals summary: Unknown error')
  })

  it('getVitalsBaseline', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getVitalsBaseline({ side: 'left', days: 30 }))
    expect(error.message).toBe('Failed to calculate vitals baseline: Unknown error')
  })

  it('reportVitals', async () => {
    forceNonErrorThrow('insert')
    const error = await rejectionOf(caller.reportVitals({
      side: 'left', timestamp: 1700000000, heartRate: 60, hrv: 50, breathingRate: 14,
    }))
    expect(error.message).toBe('Failed to report vitals: Unknown error')
  })

  it('reportVitalsBatch', async () => {
    forceNonErrorThrow('insert')
    const error = await rejectionOf(caller.reportVitalsBatch({
      vitals: [{ side: 'left', timestamp: 1700000000, heartRate: 60, hrv: 50, breathingRate: 14 }],
    }))
    expect(error.message).toBe('Failed to report vitals batch: Unknown error')
  })

  it('getSleepStages', async () => {
    forceNonErrorThrow('select')
    const error = await rejectionOf(caller.getSleepStages({ side: 'left', sleepRecordId: 1 }))
    expect(error.message).toBe('Failed to classify sleep stages: Unknown error')
  })
})

describe('biometrics numeric coercion and computed windows', () => {
  const FAKE_NOW = new Date('2025-06-15T12:00:00.000Z')
  const FAKE_NOW_SECONDS = FAKE_NOW.getTime() / 1000

  it('getMovementBuckets converts bucketStart seconds to milliseconds', async () => {
    dbState.rowsQueue.push([
      { bucketStart: 1700000, totalMovement: 250, eventCount: 3, sampleCount: 7 },
    ])
    const out = await caller.getMovementBuckets({ side: 'left', bucketSeconds: 60, limit: 100 })
    expect(out[0].bucketStart.getTime()).toBe(1_700_000_000)
  })

  it('getMovementBuckets keeps non-zero aggregates instead of falling back to zero', async () => {
    dbState.rowsQueue.push([
      { bucketStart: 1700000, totalMovement: 250, eventCount: 3, sampleCount: 7 },
    ])
    const out = await caller.getMovementBuckets({ side: 'left', bucketSeconds: 60, limit: 100 })
    expect(out[0]).toEqual({
      side: 'left',
      bucketStart: new Date(1_700_000_000),
      totalMovement: 250,
      eventCount: 3,
      sampleCount: 7,
    })
  })

  it('getVitalsSummary defaults the window to exactly seven days back', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
    dbState.rowsQueue.push([{
      avgHeartRate: '60', minHeartRate: 50, maxHeartRate: 80,
      avgHRV: '40', avgBreathingRate: '14', recordCount: 5,
    }])
    await caller.getVitalsSummary({ side: 'left' })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.params).toEqual(['left', FAKE_NOW_SECONDS - 7 * 24 * 60 * 60, FAKE_NOW_SECONDS])
  })

  it('getVitalsSummary accepts a zero-width range (start equal to end)', async () => {
    const sameInstant = new Date('2025-01-01T00:00:00Z')
    dbState.rowsQueue.push([{
      avgHeartRate: '60', minHeartRate: 50, maxHeartRate: 80,
      avgHRV: '40', avgBreathingRate: '14', recordCount: 2,
    }])
    const out = await caller.getVitalsSummary({
      side: 'left',
      startDate: sameInstant,
      endDate: sameInstant,
    })
    expect(out?.recordCount).toBe(2)
  })

  it('getVitalsSummary passes non-null min/max/avg aggregates through unchanged', async () => {
    dbState.rowsQueue.push([{
      avgHeartRate: '60', minHeartRate: 50, maxHeartRate: 80,
      avgHRV: '40', avgBreathingRate: '14', recordCount: 10,
    }])
    const out = await caller.getVitalsSummary({
      side: 'left',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-02'),
    })
    expect(out).toEqual({
      avgHeartRate: 60,
      minHeartRate: 50,
      maxHeartRate: 80,
      avgHRV: 40,
      avgBreathingRate: 14,
      recordCount: 10,
    })
  })

  it('getVitalsBaseline windows back exactly the requested number of days', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
    dbState.rowsQueue.push([{
      hrMean: '60', hrSqMean: '3604',
      hrvMean: null, hrvSqMean: null,
      brMean: null, brSqMean: null,
      sampleCount: 5,
    }])
    await caller.getVitalsBaseline({ side: 'left', days: 30 })
    const query = toQuery(dbState.whereArgs[0])
    expect(query.params).toEqual(['left', FAKE_NOW_SECONDS - 30 * 24 * 60 * 60, FAKE_NOW_SECONDS])
  })

  it('getVitalsBaseline asks SQLite for E[X²] on each vital', async () => {
    // The SD maths is E[X²] − E[X]², so each *SqMean column must average the
    // SQUARE of its own vital. Only the returned rows are asserted elsewhere,
    // which cannot tell a correct aggregate from a blank one.
    dbState.rowsQueue.push([{
      hrMean: null, hrSqMean: null,
      hrvMean: null, hrvSqMean: null,
      brMean: null, brSqMean: null,
      sampleCount: 0,
    }])
    await caller.getVitalsBaseline({ side: 'left', days: 30 })
    const fields = dbState.selectFields[0] as Record<string, unknown>
    expect(toQuery(fields.hrSqMean).sql).toBe('AVG("vitals"."heart_rate" * "vitals"."heart_rate")')
    expect(toQuery(fields.hrvSqMean).sql).toBe('AVG("vitals"."hrv" * "vitals"."hrv")')
    expect(toQuery(fields.brSqMean).sql).toBe('AVG("vitals"."breathing_rate" * "vitals"."breathing_rate")')
  })

  it('getVitalsBaseline clamps a negative variance to SD 0', async () => {
    // mean=60, sqMean=3500 → variance=-100; sqrt would be NaN.
    dbState.rowsQueue.push([{
      hrMean: '60', hrSqMean: '3500',
      hrvMean: null, hrvSqMean: null,
      brMean: null, brSqMean: null,
      sampleCount: 20,
    }])
    const out = await caller.getVitalsBaseline({ side: 'left', days: 30 })
    expect(out?.hrSD).toBe(0)
  })

  it('getVitalsBaseline reports null means when the SQL averages are null', async () => {
    dbState.rowsQueue.push([{
      hrMean: null, hrSqMean: null,
      hrvMean: '50', hrvSqMean: '2509',
      brMean: null, brSqMean: null,
      sampleCount: 20,
    }])
    const out = await caller.getVitalsBaseline({ side: 'left', days: 30 })
    expect(out?.hrMean).toBeNull()
    expect(out?.brMean).toBeNull()
    expect(out?.hrvMean).toBe(50)
  })

  it('reportVitals converts the unix-second timestamp to milliseconds', async () => {
    await caller.reportVitals({
      side: 'right', timestamp: 1700000000,
      heartRate: 60, hrv: 50, breathingRate: 14,
    })
    const values = dbState.insertValues[0] as { side: string, timestamp: Date, heartRate: number | null }
    expect(values.side).toBe('right')
    expect(values.timestamp.getTime()).toBe(1_700_000_000_000)
    expect(values.heartRate).toBe(60)
  })

  it('reportVitalsBatch converts every unix-second timestamp to milliseconds', async () => {
    dbState.rowsQueue.push([{ id: 1 }, { id: 2 }])
    await caller.reportVitalsBatch({
      vitals: [
        { side: 'left', timestamp: 1700000000, heartRate: 60, hrv: 50, breathingRate: 14 },
        { side: 'right', timestamp: 1700000300, heartRate: 61, hrv: 51, breathingRate: 15 },
      ],
    })
    const rows = dbState.insertValues[0] as { side: string, timestamp: Date }[]
    expect(rows.map(r => r.timestamp.getTime())).toEqual([1_700_000_000_000, 1_700_000_300_000])
    expect(rows.map(r => r.side)).toEqual(['left', 'right'])
  })
})

describe('biometrics.updateSleepRecord duration recomputation', () => {
  it('writes a duration derived from the difference in seconds', async () => {
    const entered = new Date('2025-01-01T22:00:00Z')
    const left = new Date('2025-01-02T06:30:00Z')
    dbState.txRowsQueue.push([{ id: 1, side: 'left', enteredBedAt: entered, leftBedAt: left }])
    dbState.txRowsQueue.push([{
      id: 1, side: 'left',
      enteredBedAt: entered, leftBedAt: left,
      sleepDurationSeconds: 30600, timesExitedBed: 0,
      presentIntervals: null, notPresentIntervals: null, createdAt: new Date(0),
    }])
    await caller.updateSleepRecord({ id: 1, enteredBedAt: entered, leftBedAt: left })
    expect(dbState.txSetValues[0]).toEqual({
      enteredBedAt: entered,
      leftBedAt: left,
      sleepDurationSeconds: 8.5 * 3600,
    })
  })

  it('accepts leftBedAt on its own and recomputes against the stored enteredBedAt', async () => {
    const entered = new Date('2025-01-01T22:00:00Z')
    const storedLeft = new Date('2025-01-02T02:00:00Z')
    const newLeft = new Date('2025-01-02T06:00:00Z')
    dbState.txRowsQueue.push([{ id: 4, side: 'left', enteredBedAt: entered, leftBedAt: storedLeft }])
    dbState.txRowsQueue.push([{
      id: 4, side: 'left',
      enteredBedAt: entered, leftBedAt: newLeft,
      sleepDurationSeconds: 8 * 3600, timesExitedBed: 0,
      presentIntervals: null, notPresentIntervals: null, createdAt: new Date(0),
    }])
    const out = await caller.updateSleepRecord({ id: 4, leftBedAt: newLeft })
    expect(out.id).toBe(4)
    expect(dbState.txSetValues[0]).toEqual({
      leftBedAt: newLeft,
      sleepDurationSeconds: 8 * 3600,
    })
  })

  it('rejects a leftBedAt exactly equal to enteredBedAt', async () => {
    const sameInstant = new Date('2025-01-01T22:00:00Z')
    dbState.txRowsQueue.push([
      { id: 1, side: 'left', enteredBedAt: sameInstant, leftBedAt: new Date('2025-01-02T06:00:00Z') },
    ])
    const error = await rejectionOf(caller.updateSleepRecord({
      id: 1,
      enteredBedAt: sameInstant,
      leftBedAt: sameInstant,
    }))
    expect(error.code).toBe('BAD_REQUEST')
    expect(error.message).toBe('leftBedAt must be after enteredBedAt')
  })
})

describe('biometrics.getSleepStages last-night selection', () => {
  const FAKE_NOW = new Date('2025-06-15T12:00:00.000Z')
  const FAKE_NOW_SECONDS = FAKE_NOW.getTime() / 1000

  function sleepRecordAt(id: number, enteredIso: string, durationSeconds: number) {
    const entered = new Date(enteredIso)
    return {
      id,
      side: 'left',
      enteredBedAt: entered,
      leftBedAt: new Date(entered.getTime() + durationSeconds * 1000),
      sleepDurationSeconds: durationSeconds,
      timesExitedBed: 0,
      presentIntervals: null,
      notPresentIntervals: null,
      createdAt: entered,
    }
  }

  /** Decoy that is never "overnight" (11:00 UTC) but is the longest record in
   * the 24 h window, so it wins whenever the overnight rule rejects the
   * candidate under test. */
  const utcDecoy = () => sleepRecordAt(99, '2025-06-15T11:00:00.000Z', 20000)

  /** Run the default (no-argument) branch over `records` and report which
   * record the last-night heuristic settled on. */
  async function selectedRecordId(records: unknown[]): Promise<number | null> {
    dbState.rowsQueue.push(records)
    dbState.rowsQueue.push([])
    dbState.rowsQueue.push([])
    const out = await caller.getSleepStages({ side: 'left' })
    return out.sleepRecordId
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
    dbState.settingsRows = [{ timezone: 'UTC' }]
  })

  it('searches sleep records back exactly seven days', async () => {
    await selectedRecordId([])
    const query = toQuery(dbState.whereArgs[0])
    expect(query.sql).toBe('("sleep_records"."side" = ? and "sleep_records"."entered_bed_at" >= ?)')
    expect(query.params).toEqual(['left', FAKE_NOW_SECONDS - 7 * 24 * 60 * 60])
  })

  it('prefers an overnight session entered at 22:00 local time', async () => {
    const overnight = sleepRecordAt(1, '2025-06-14T22:00:00.000Z', 10800)
    expect(await selectedRecordId([overnight, utcDecoy()])).toBe(1)
  })

  it('counts 20:00 local as inside the overnight window', async () => {
    const atEight = sleepRecordAt(2, '2025-06-14T20:00:00.000Z', 10800)
    expect(await selectedRecordId([atEight, utcDecoy()])).toBe(2)
  })

  it('counts 04:00 local as outside the overnight window', async () => {
    const atFour = sleepRecordAt(3, '2025-06-15T04:00:00.000Z', 10800)
    expect(await selectedRecordId([atFour, utcDecoy()])).toBe(99)
  })

  it('counts 02:00 local as inside the overnight window', async () => {
    const atTwo = sleepRecordAt(4, '2025-06-15T02:00:00.000Z', 10800)
    expect(await selectedRecordId([atTwo, utcDecoy()])).toBe(4)
  })

  it('rejects a long daytime session entered at 09:00 local time', async () => {
    const daytime = sleepRecordAt(5, '2025-06-15T09:00:00.000Z', 10800)
    expect(await selectedRecordId([daytime, utcDecoy()])).toBe(99)
  })

  it('requires at least three hours before an overnight session qualifies', async () => {
    const justShort = sleepRecordAt(6, '2025-06-14T22:00:00.000Z', 10799)
    expect(await selectedRecordId([justShort, utcDecoy()])).toBe(99)
  })

  it('classifies overnight against the configured device timezone', async () => {
    dbState.settingsRows = [{ timezone: 'Asia/Tokyo' }]
    // 13:00 UTC is 22:00 in Tokyo but only 06:00 in America/Los_Angeles.
    const tokyoOvernight = sleepRecordAt(7, '2025-06-14T13:00:00.000Z', 10800)
    // 02:00 UTC is daytime in both zones (11:00 Tokyo / 19:00 Los Angeles).
    const decoy = sleepRecordAt(99, '2025-06-15T02:00:00.000Z', 20000)
    expect(await selectedRecordId([tokyoOvernight, decoy])).toBe(7)
  })

  it('falls back to America/Los_Angeles when device settings have no row', async () => {
    dbState.settingsRows = []
    // 05:00 UTC is 22:00 in America/Los_Angeles (PDT).
    const laOvernight = sleepRecordAt(8, '2025-06-15T05:00:00.000Z', 10800)
    const decoy = sleepRecordAt(99, '2025-06-15T02:00:00.000Z', 20000)
    expect(await selectedRecordId([laOvernight, decoy])).toBe(8)
  })

  it('includes a record sitting exactly on the 24-hour boundary in the fallback', async () => {
    const older = sleepRecordAt(20, '2025-06-12T11:00:00.000Z', 200)
    const onBoundary = sleepRecordAt(21, '2025-06-14T12:00:00.000Z', 100)
    expect(await selectedRecordId([older, onBoundary])).toBe(21)
  })

  it('keeps the first record when two 24-hour candidates tie on duration', async () => {
    const first = sleepRecordAt(30, '2025-06-15T09:00:00.000Z', 500)
    const second = sleepRecordAt(31, '2025-06-15T10:00:00.000Z', 500)
    expect(await selectedRecordId([first, second])).toBe(30)
  })
})

describe('biometrics.getSleepStages query window', () => {
  const FAKE_NOW = new Date('2025-06-15T12:00:00.000Z')

  it('bounds vitals and movement by the record bed times for a closed session', async () => {
    const record = {
      id: 1, side: 'left',
      enteredBedAt: new Date('2025-01-01T22:00:00Z'),
      leftBedAt: new Date('2025-01-02T07:00:00Z'),
    }
    dbState.rowsQueue.push([record])
    dbState.rowsQueue.push([])
    dbState.rowsQueue.push([])
    await caller.getSleepStages({ side: 'left', sleepRecordId: 1 })

    const vitalsQuery = toQuery(dbState.whereArgs[1])
    expect(vitalsQuery.sql).toBe('("vitals"."side" = ? and "vitals"."timestamp" >= ? and "vitals"."timestamp" <= ?)')
    expect(vitalsQuery.params).toEqual(['left', 1735768800, 1735801200])

    const movementQuery = toQuery(dbState.whereArgs[2])
    expect(movementQuery.sql).toBe('("movement"."side" = ? and "movement"."timestamp" >= ? and "movement"."timestamp" <= ?)')
    expect(movementQuery.params).toEqual(['left', 1735768800, 1735801200])
  })

  it('bounds the window at the current time for an active session', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(FAKE_NOW)
    const record = {
      id: 7, side: 'left',
      enteredBedAt: new Date('2025-06-15T04:00:00Z'),
      leftBedAt: null,
    }
    dbState.rowsQueue.push([record])
    dbState.rowsQueue.push([])
    dbState.rowsQueue.push([])
    await caller.getSleepStages({ side: 'left', sleepRecordId: 7 })

    const vitalsQuery = toQuery(dbState.whereArgs[1])
    expect(vitalsQuery.params).toEqual(['left', 1749960000, FAKE_NOW.getTime() / 1000])
  })

  it('returns the zeroed result without merging blocks when no epochs classify', async () => {
    const record = {
      id: 3, side: 'left',
      enteredBedAt: new Date('2025-01-01T22:00:00Z'),
      leftBedAt: new Date('2025-01-02T07:00:00Z'),
    }
    dbState.rowsQueue.push([record])
    dbState.rowsQueue.push([])
    dbState.rowsQueue.push([])
    sleepStagesMock.classifySleepStages.mockReturnValue([])
    sleepStagesMock.mergeIntoBlocks.mockReturnValue([{ start: 0, end: 1, stage: 'light' }])
    sleepStagesMock.calculateDistribution.mockReturnValue({ wake: 1, light: 2, deep: 3, rem: 4 })
    sleepStagesMock.calculateQualityScore.mockReturnValue(55)

    const out = await caller.getSleepStages({ side: 'left', sleepRecordId: 3 })
    expect(out).toEqual({
      epochs: [],
      blocks: [],
      distribution: { wake: 0, light: 0, deep: 0, rem: 0 },
      qualityScore: 0,
      totalSleepMs: 0,
      sleepRecordId: 3,
      enteredBedAt: record.enteredBedAt.getTime(),
      leftBedAt: record.leftBedAt.getTime(),
    })
    expect(sleepStagesMock.mergeIntoBlocks).not.toHaveBeenCalled()
  })
})
