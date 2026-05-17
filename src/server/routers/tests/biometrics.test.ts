/**
 * Tests for the biometrics router. Covers happy path of every procedure
 * plus key branches: BAD_REQUEST date-range checks, NOT_FOUND for missing
 * IDs, sleep-stage fallback paths.
 *
 * biometricsDb (thenable chain + transaction), db (top-level select for
 * device timezone), raw helper, and sleep-stages classifier are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbState = vi.hoisted(() => ({
  rowsQueue: [] as unknown[][],
  txRowsQueue: [] as unknown[][],
  popRows(): unknown[] { return dbState.rowsQueue.shift() ?? [] },
  popTx(): unknown[] { return dbState.txRowsQueue.shift() ?? [] },
}))

const dbMock = vi.hoisted(() => {
  const makeChain = () => {
    const chain: Record<string, unknown> = {}
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(dbState.popRows()).then(resolve)
    chain.where = vi.fn(() => chain)
    chain.orderBy = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.onConflictDoNothing = vi.fn(() => chain)
    chain.returning = vi.fn(() => chain)
    chain.groupBy = vi.fn(() => chain)
    chain.having = vi.fn(() => chain)
    return chain
  }

  const makeTxChain = () => {
    const chain: Record<string, unknown> = {}
    chain.where = vi.fn(() => chain)
    chain.limit = vi.fn(() => chain)
    chain.from = vi.fn(() => chain)
    chain.values = vi.fn(() => chain)
    chain.set = vi.fn(() => chain)
    chain.returning = vi.fn(() => chain)
    chain.all = vi.fn(() => dbState.popTx())
    return chain
  }

  const select = vi.fn(() => makeChain())
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
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve([{ timezone: 'America/Los_Angeles' }]).then(resolve)
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
    movement: { active: boolean, peakScore: number }
    level: { active: boolean, deviation: number | null, threshold: number | null, ageMs: number | null }
  }>(() => ({
    occupied: false,
    movement: { active: false, peakScore: 0 },
    level: { active: false, deviation: null, threshold: null, ageMs: null },
  })),
}))
vi.mock('@/src/lib/occupancy', () => occupancyMock)

const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const caller = biometricsRouter.createCaller({})

beforeEach(() => {
  dbState.rowsQueue.length = 0
  dbState.txRowsQueue.length = 0
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
      movement: { active: false, peakScore: 5 },
      level: { active: true, deviation: 12.3, threshold: 6, ageMs: 500 },
    })
    const out = await caller.getOccupancy()
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
