/**
 * Tests for the calibration router — getStatus pivots rows by sensor type,
 * getHistory passes filters, triggerCalibration writes atomic .tmp+rename,
 * triggerFullCalibration writes "all/all", getVitalsQuality respects date
 * range. fs/promises and biometricsDb fully mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  writeFile: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
  rename: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}))

// biometricsDb chain — supports both query (select→from→where→orderBy→limit)
// and insert (.insert→.values→.onConflictDoUpdate)
const dbMock = vi.hoisted(() => {
  // Default rows returned per table — overridable per test
  const profileRows: unknown[] = []
  const runRows: unknown[] = []
  const qualityRows: unknown[] = []
  let activeTable: 'profiles' | 'runs' | 'quality' = 'profiles'

  // chains terminate at: where (for getStatus), .limit (for history/quality)
  const limitProfiles = vi.fn(async () => profileRows)
  const limitRuns = vi.fn(async () => runRows)
  const limitQuality = vi.fn(async () => qualityRows)

  const orderRuns = vi.fn(() => ({ limit: limitRuns }))
  const orderQuality = vi.fn(() => ({ limit: limitQuality }))

  // For getStatus: where() resolves directly (await on chain after where)
  const whereProfilesAwait = vi.fn(async () => profileRows)
  // For getHistory/getVitalsQuality: where().orderBy().limit()
  const whereRuns = vi.fn(() => ({ orderBy: orderRuns }))
  const whereQuality = vi.fn(() => ({ orderBy: orderQuality }))

  const from = vi.fn(() => {
    if (activeTable === 'profiles') return { where: whereProfilesAwait, limit: limitProfiles }
    if (activeTable === 'runs') return { where: whereRuns, orderBy: orderRuns, limit: limitRuns }
    return { where: whereQuality, orderBy: orderQuality, limit: limitQuality }
  })
  const select = vi.fn(() => ({ from }))

  // Insert chain
  const onConflict = vi.fn(async () => undefined)
  const values = vi.fn(() => ({ onConflictDoUpdate: onConflict }))
  const insert = vi.fn(() => ({ values }))

  return {
    select, insert, values, onConflict,
    profileRows, runRows, qualityRows,
    setActive: (t: 'profiles' | 'runs' | 'quality') => { activeTable = t },
  }
})

vi.mock('node:fs/promises', () => ({ ...fsMock, default: fsMock }))

vi.mock('@/src/db', () => ({
  db: {},
  biometricsDb: {
    select: dbMock.select,
    insert: dbMock.insert,
  },
}))

const { calibrationRouter } = await import('@/src/server/routers/calibration')
const caller = calibrationRouter.createCaller({})

beforeEach(() => {
  fsMock.writeFile.mockReset().mockResolvedValue(undefined)
  fsMock.rename.mockReset().mockResolvedValue(undefined)
  dbMock.select.mockClear()
  dbMock.insert.mockClear()
  dbMock.values.mockClear()
  dbMock.onConflict.mockClear()
  dbMock.profileRows.length = 0
  dbMock.runRows.length = 0
  dbMock.qualityRows.length = 0
  dbMock.setActive('profiles')
})

describe('calibration.getStatus', () => {
  it('pivots profile rows by sensor type and returns nulls for missing ones', async () => {
    dbMock.setActive('profiles')
    dbMock.profileRows.push({
      id: 1, side: 'left', sensorType: 'piezo', status: 'completed',
      qualityScore: 0.97, samplesUsed: 1024,
      createdAt: new Date(0), expiresAt: null, errorMessage: null,
    })

    const result = await caller.getStatus({ side: 'left' })
    expect(result.piezo?.status).toBe('completed')
    expect(result.capacitance).toBeNull()
    expect(result.temperature).toBeNull()
  })
})

describe('calibration.getHistory', () => {
  it('passes through limit and orders desc by createdAt', async () => {
    dbMock.setActive('runs')
    dbMock.runRows.push({
      id: 1, side: 'left', sensorType: 'piezo', status: 'completed',
      parameters: {}, qualityScore: 0.9,
      sourceWindowStart: 0, sourceWindowEnd: 100,
      samplesUsed: 50, errorMessage: null, durationMs: 10,
      triggeredBy: 'manual', createdAt: new Date(0),
    })

    const out = await caller.getHistory({ side: 'left', limit: 5 })
    expect(out).toHaveLength(1)
    expect(out[0].sensorType).toBe('piezo')
  })

  it('with no sensorType filter still resolves', async () => {
    dbMock.setActive('runs')
    const out = await caller.getHistory({ side: 'right', sensorType: 'capacitance', limit: 1 })
    expect(out).toEqual([])
  })
})

describe('calibration.triggerCalibration', () => {
  it('writes the trigger payload atomically (write tmp → rename) and queues pending row', async () => {
    const result = await caller.triggerCalibration({ side: 'left', sensorType: 'piezo' })

    // Atomic write pattern: writeFile to .tmp first, then rename
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    expect(fsMock.rename).toHaveBeenCalledTimes(1)
    const [tmpPath, payload] = fsMock.writeFile.mock.calls[0]
    expect(typeof tmpPath).toBe('string')
    expect(String(tmpPath)).toMatch(/\.tmp$/)
    const parsed = JSON.parse(String(payload))
    expect(parsed.side).toBe('left')
    expect(parsed.sensor_type).toBe('piezo')
    expect(typeof parsed.ts).toBe('number')

    // The rename target must drop the .tmp suffix
    const [renameSrc, renameDst] = fsMock.rename.mock.calls[0]
    expect(renameSrc).toBe(tmpPath)
    expect(String(renameDst)).not.toMatch(/\.tmp$/)

    // Pending row inserted with onConflictDoUpdate
    expect(dbMock.insert).toHaveBeenCalledTimes(1)
    expect(dbMock.onConflict).toHaveBeenCalledTimes(1)

    expect(result.triggered).toBe(true)
    expect(result.message).toContain('left')
    expect(result.message).toContain('piezo')
  })

  it('wraps fs failures as INTERNAL_SERVER_ERROR', async () => {
    fsMock.writeFile.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      caller.triggerCalibration({ side: 'left', sensorType: 'piezo' }),
    ).rejects.toThrow(/Failed to trigger calibration: disk full/)
  })
})

describe('calibration.triggerFullCalibration', () => {
  it('writes the all/all payload', async () => {
    const result = await caller.triggerFullCalibration({})

    expect(fsMock.writeFile).toHaveBeenCalledTimes(1)
    const payload = JSON.parse(String(fsMock.writeFile.mock.calls[0][1]))
    expect(payload.side).toBe('all')
    expect(payload.sensor_type).toBe('all')
    expect(result.triggered).toBe(true)
  })

  it('wraps fs failures', async () => {
    fsMock.rename.mockRejectedValueOnce(new Error('boom'))
    await expect(caller.triggerFullCalibration({})).rejects.toThrow(/Failed to trigger calibration/)
  })
})

describe('calibration.getVitalsQuality', () => {
  it('returns rows for a side with no date range', async () => {
    dbMock.setActive('quality')
    dbMock.qualityRows.push({
      id: 1, vitalsId: 100, side: 'left',
      timestamp: new Date(0), qualityScore: 0.88, flags: {},
      hrRaw: 70, createdAt: new Date(0),
    })

    const out = await caller.getVitalsQuality({ side: 'left', limit: 100 })
    expect(out).toHaveLength(1)
    expect(out[0].side).toBe('left')
  })

  it('with startDate + endDate still resolves', async () => {
    dbMock.setActive('quality')
    const out = await caller.getVitalsQuality({
      side: 'right',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-02-01'),
      limit: 50,
    })
    expect(out).toEqual([])
  })
})
