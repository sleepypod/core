import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '../biometrics-schema'
import {
  ambientLight,
  bedTemp,
  flowReadings,
  freezerTemp,
  movement,
  pumpAlerts,
  vitals,
  waterLevelReadings,
} from '../biometrics-schema'

// Mock the biometrics module so runRetentionPass / startBiometricsRetention,
// which reference the module-level biometricsDb, hit a per-test in-memory DB.
const mockState = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle<typeof schema>> | null,
}))

vi.mock('../biometrics', () => ({
  get biometricsDb() {
    if (!mockState.db) throw new Error('biometricsDb mock not initialised')
    return mockState.db
  },
  closeBiometricsDatabase: () => {},
}))

const {
  configureAutoVacuum,
  pruneOldBiometrics,
  runRetentionPass,
  startBiometricsRetention,
  stopBiometricsRetention,
} = await import('../retention')

type BiometricsDb = ReturnType<typeof drizzle<typeof schema>>

function openTempDb(): { db: BiometricsDb, close: () => void } {
  const raw = new Database(':memory:')
  raw.pragma('journal_mode = WAL')
  raw.pragma('busy_timeout = 5000')
  raw.pragma('foreign_keys = ON')
  const db = drizzle(raw, { schema })
  migrate(db, {
    migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations'),
  })
  return { db, close: () => raw.close() }
}

function getDb(): BiometricsDb {
  if (!mockState.db) throw new Error('test db not initialised')
  return mockState.db
}

function seedAllTables(db: BiometricsDb, ts: Date): void {
  db.insert(vitals).values({ side: 'left', timestamp: ts, heartRate: 60 }).run()
  db.insert(movement).values({ side: 'left', timestamp: ts, totalMovement: 1 }).run()
  db.insert(bedTemp).values({ timestamp: ts }).run()
  db.insert(freezerTemp).values({ timestamp: ts }).run()
  db.insert(flowReadings).values({ timestamp: ts }).run()
  db.insert(ambientLight).values({ timestamp: ts, lux: 1 }).run()
  db.insert(waterLevelReadings).values({ timestamp: ts, level: 'ok' }).run()
  db.insert(pumpAlerts).values({ timestamp: ts, type: 'stall_left' }).run()
}

describe('pruneOldBiometrics', () => {
  let db: BiometricsDb
  let close: () => void

  beforeEach(() => {
    ({ db, close } = openTempDb())
  })

  afterEach(() => {
    close()
  })

  it('deletes rows older than cutoff across all time-series tables', () => {
    const old = new Date('2025-01-01T00:00:00Z')
    const fresh = new Date('2026-04-01T00:00:00Z')
    const cutoff = new Date('2025-06-01T00:00:00Z')

    db.insert(vitals).values([
      { side: 'left', timestamp: old, heartRate: 60 },
      { side: 'right', timestamp: fresh, heartRate: 62 },
    ]).run()
    db.insert(movement).values([
      { side: 'left', timestamp: old, totalMovement: 1 },
      { side: 'right', timestamp: fresh, totalMovement: 2 },
    ]).run()
    db.insert(bedTemp).values([
      { timestamp: old },
      { timestamp: fresh },
    ]).run()
    db.insert(freezerTemp).values([
      { timestamp: old },
      { timestamp: fresh },
    ]).run()
    db.insert(flowReadings).values([
      { timestamp: old },
      { timestamp: fresh },
    ]).run()
    db.insert(ambientLight).values([
      { timestamp: old, lux: 10 },
      { timestamp: fresh, lux: 20 },
    ]).run()
    db.insert(waterLevelReadings).values([
      { timestamp: old, level: 'ok' },
      { timestamp: fresh, level: 'low' },
    ]).run()
    db.insert(pumpAlerts).values([
      { timestamp: old, type: 'stall_left' },
      { timestamp: fresh, type: 'stall_right' },
    ]).run()

    db.insert(schema.vitalsQuality).values([
      { vitalsId: 1, side: 'left', timestamp: old, qualityScore: 0.5 },
      { vitalsId: 2, side: 'left', timestamp: fresh, qualityScore: 0.9 },
    ]).run()

    const result = pruneOldBiometrics(cutoff, db)

    expect(result.rowsDeleted).toBe(9)
    expect(result.perTable).toEqual({
      vitals: 1,
      vitals_quality: 1,
      movement: 1,
      bed_temp: 1,
      freezer_temp: 1,
      flow_readings: 1,
      ambient_light: 1,
      water_level_readings: 1,
      pump_alerts: 1,
    })

    // Verify fresh rows remain
    expect(db.select().from(vitals).all()).toHaveLength(1)
    expect(db.select().from(movement).all()).toHaveLength(1)
    expect(db.select().from(bedTemp).all()).toHaveLength(1)
    expect(db.select().from(freezerTemp).all()).toHaveLength(1)
    expect(db.select().from(flowReadings).all()).toHaveLength(1)
    expect(db.select().from(ambientLight).all()).toHaveLength(1)
    expect(db.select().from(waterLevelReadings).all()).toHaveLength(1)
    expect(db.select().from(pumpAlerts).all()).toHaveLength(1)
  })

  it('leaves everything alone when cutoff precedes all rows', () => {
    const t = new Date('2026-04-01T00:00:00Z')
    db.insert(vitals).values({ side: 'left', timestamp: t, heartRate: 60 }).run()

    const result = pruneOldBiometrics(new Date('2020-01-01T00:00:00Z'), db)
    expect(result.rowsDeleted).toBe(0)
    expect(db.select().from(vitals).all()).toHaveLength(1)
  })

  it('does not touch sleep_records or calibration_* tables', () => {
    const old = new Date('2020-01-01T00:00:00Z')
    db.insert(schema.sleepRecords).values({
      side: 'left',
      enteredBedAt: old,
      leftBedAt: old,
      sleepDurationSeconds: 1,
    }).run()
    db.insert(schema.calibrationProfiles).values({
      side: 'left',
      sensorType: 'piezo',
      parameters: '{}',
      createdAt: old,
    }).run()

    pruneOldBiometrics(new Date('2026-01-01T00:00:00Z'), db)

    expect(db.select().from(schema.sleepRecords).all()).toHaveLength(1)
    expect(db.select().from(schema.calibrationProfiles).all()).toHaveLength(1)
  })

  it('prunes vitals_quality in lockstep with vitals (no orphans)', () => {
    // vitals_quality.vitals_id logically references vitals.id but no FK is
    // enforced (SQLite FKs are off in every writer). Both tables share the
    // same timestamp cutoff so each quality row dies with its paired vitals
    // row — previously quality rows orphaned forever (review 4.17).
    const old = new Date('2020-01-01T00:00:00Z')
    const fresh = new Date('2026-06-01T00:00:00Z')
    const inserted = db.insert(vitals).values([
      { side: 'left', timestamp: old, heartRate: 60 },
      { side: 'left', timestamp: fresh, heartRate: 62 },
    ]).returning({ id: vitals.id }).all()
    db.insert(schema.vitalsQuality).values([
      { vitalsId: inserted[0].id, side: 'left', timestamp: old, qualityScore: 0.8 },
      { vitalsId: inserted[1].id, side: 'left', timestamp: fresh, qualityScore: 0.9 },
    ]).run()

    const result = pruneOldBiometrics(new Date('2026-01-01T00:00:00Z'), db)

    expect(result.perTable.vitals).toBe(1)
    expect(result.perTable.vitals_quality).toBe(1)
    // The surviving quality row still pairs with the surviving vitals row.
    const remaining = db.select().from(schema.vitalsQuality).all()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].vitalsId).toBe(inserted[1].id)
  })

  it('uses strict less-than semantics at the cutoff boundary', () => {
    // lt() must keep rows whose timestamp equals cutoff exactly. drizzle's
    // `mode: 'timestamp'` stores at second resolution, so use ±1s offsets.
    const cutoff = new Date('2026-04-01T00:00:00.000Z')
    const justBefore = new Date(cutoff.getTime() - 1000)
    const justAfter = new Date(cutoff.getTime() + 1000)

    db.insert(vitals).values([
      { side: 'left', timestamp: justBefore, heartRate: 60 },
      { side: 'right', timestamp: cutoff, heartRate: 61 },
      { side: 'left', timestamp: justAfter, heartRate: 62 },
    ]).run()

    const result = pruneOldBiometrics(cutoff, db)

    expect(result.perTable.vitals).toBe(1)
    const remaining = db.select({ ts: vitals.timestamp }).from(vitals).all()
    expect(remaining).toHaveLength(2)
    expect(remaining.map(r => r.ts.getTime()).sort()).toEqual(
      [cutoff.getTime(), justAfter.getTime()].sort(),
    )
  })

  it('returns zero counts for every table on an empty database', () => {
    const result = pruneOldBiometrics(new Date('2030-01-01T00:00:00Z'), db)

    expect(result.rowsDeleted).toBe(0)
    expect(result.perTable).toEqual({
      vitals: 0,
      vitals_quality: 0,
      movement: 0,
      bed_temp: 0,
      freezer_temp: 0,
      flow_readings: 0,
      ambient_light: 0,
      water_level_readings: 0,
      pump_alerts: 0,
    })
  })

  it('prunes across multi-day spans, leaving only rows on/after cutoff', () => {
    // Five days of one-row-per-day samples; cutoff at day 3 → days 0,1,2 go.
    const day = 86_400_000
    const base = new Date('2026-01-01T00:00:00Z').getTime()
    for (let i = 0; i < 5; i++) {
      seedAllTables(db, new Date(base + i * day))
    }

    const cutoff = new Date(base + 3 * day)
    const result = pruneOldBiometrics(cutoff, db)

    // Eight tables × 3 deleted days = 24 rows.
    expect(result.rowsDeleted).toBe(24)
    for (const tableName of ['vitals', 'movement', 'bed_temp', 'freezer_temp',
      'flow_readings', 'ambient_light', 'water_level_readings', 'pump_alerts'] as const) {
      expect(result.perTable[tableName]).toBe(3)
    }
    expect(db.select().from(vitals).all()).toHaveLength(2)
    expect(db.select().from(waterLevelReadings).all()).toHaveLength(2)
  })
})

describe('runRetentionPass', () => {
  let close: () => void

  beforeEach(() => {
    const opened = openTempDb()
    mockState.db = opened.db
    close = opened.close
  })

  afterEach(() => {
    close()
    mockState.db = null
    vi.restoreAllMocks()
  })

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['zero', 0],
    ['negative', -1],
  ])('throws when retentionDays is %s', (_, value) => {
    expect(() => runRetentionPass(value)).toThrow(/positive finite number/)
  })

  it('prunes rows older than retentionDays days from now', () => {
    const now = Date.now()
    const ancient = new Date(now - 1000 * 86_400_000)
    const recent = new Date(now - 1 * 60_000)

    seedAllTables(getDb(), ancient)
    seedAllTables(getDb(), recent)

    const result = runRetentionPass(7)

    expect(result.rowsDeleted).toBe(8)
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
  })

  it('skips incremental_vacuum when nothing was deleted', () => {
    const runSpy = vi.spyOn(getDb(), 'run')

    const result = runRetentionPass(30)

    expect(result.rowsDeleted).toBe(0)
    expect(runSpy).not.toHaveBeenCalled()
  })

  it('runs incremental_vacuum after a non-empty prune', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    const runSpy = vi.spyOn(getDb(), 'run')

    const result = runRetentionPass(30)

    expect(result.rowsDeleted).toBeGreaterThan(0)
    expect(runSpy).toHaveBeenCalledTimes(1)
  })

  it('swallows incremental_vacuum failures and still returns the result', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(getDb(), 'run').mockImplementation(() => {
      throw new Error('vacuum boom')
    })

    const result = runRetentionPass(30)

    expect(result.rowsDeleted).toBeGreaterThan(0)
    expect(warn).toHaveBeenCalledWith(
      '[retention] incremental_vacuum failed:',
      'vacuum boom',
    )
  })

  it('logs non-Error vacuum throwables verbatim', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(getDb(), 'run').mockImplementation(() => {
      throw 'plain string'
    })

    runRetentionPass(30)

    expect(warn).toHaveBeenCalledWith(
      '[retention] incremental_vacuum failed:',
      'plain string',
    )
  })
})

describe('configureAutoVacuum', () => {
  it('always closes the temporary SQLite handle', () => {
    const close = vi.spyOn(Database.prototype, 'close')
    try {
      configureAutoVacuum(':memory:')
      expect(close).toHaveBeenCalledTimes(1)
    }
    finally {
      close.mockRestore()
    }
  })

  it('sets auto_vacuum = INCREMENTAL on a fresh DB file', () => {
    const tmpPath = path.join(
      process.cwd(),
      `tmp-autovacuum-${process.pid}-${Date.now()}.db`,
    )
    try {
      configureAutoVacuum(tmpPath)
      const raw = new Database(tmpPath)
      try {
        const mode = raw.pragma('auto_vacuum', { simple: true })
        // 0=NONE, 1=FULL, 2=INCREMENTAL
        expect(mode).toBe(2)
      }
      finally {
        raw.close()
      }
    }
    finally {
      try {
        fs.unlinkSync(tmpPath)
      }
      catch {
        // ignore — best-effort cleanup of a temp file
      }
    }
  })
})

describe('startBiometricsRetention / stopBiometricsRetention', () => {
  let close: () => void

  beforeEach(() => {
    const opened = openTempDb()
    mockState.db = opened.db
    close = opened.close
    vi.useFakeTimers()

    // Guard mutation tests against invalid zero/sub-millisecond recurring
    // intervals. Without this, arithmetic/validation mutants can make a
    // large fake-timer advance execute millions of callbacks and time out
    // instead of failing at the faulty interval calculation.
    const fakeSetInterval = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((...params: Parameters<typeof setInterval>) => {
      const [callback, delay, ...args] = params
      if (typeof delay === 'number' && delay < 1_000) {
        throw new Error(`retention interval is implausibly short: ${delay}`)
      }
      return fakeSetInterval(callback, delay, ...args)
    }) as typeof setInterval)
  })

  afterEach(() => {
    stopBiometricsRetention()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete process.env.BIOMETRICS_RETENTION_DAYS
    delete process.env.BIOMETRICS_RETENTION_INTERVAL_HOURS
    close()
    mockState.db = null
  })

  it('runs the initial pass after the configured delay and again per interval', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    startBiometricsRetention({
      retentionDays: 30,
      intervalHours: 1,
      initialDelayMs: 1_000,
    })

    // Before delay elapses, nothing has run.
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('[retention] Pruned'),
      expect.any(Object),
    )

    // Re-seed and confirm the recurring interval fires too.
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    vi.advanceTimersByTime(3_600_000)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)
  })

  it('is idempotent: a second start while one is pending is a no-op', () => {
    startBiometricsRetention({
      retentionDays: 7,
      intervalHours: 24,
      initialDelayMs: 5_000,
    })
    expect(vi.getTimerCount()).toBe(1)
    // Second call should NOT replace the timer or schedule extra work.
    startBiometricsRetention({
      retentionDays: 7,
      intervalHours: 24,
      initialDelayMs: 5_000,
    })
    expect(vi.getTimerCount()).toBe(1)

    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    vi.advanceTimersByTime(5_000)
    // Only one prune ran, so seeded rows are gone.
    expect(getDb().select().from(vitals).all()).toHaveLength(0)

    // A re-seed plus full interval should trigger exactly one more prune,
    // not two — which would happen if the second start had stuck.
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    vi.advanceTimersByTime(24 * 3_600_000)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)
  })

  it('reads BIOMETRICS_RETENTION_DAYS from env when no option supplied', () => {
    process.env.BIOMETRICS_RETENTION_DAYS = '10'
    seedAllTables(getDb(), new Date(Date.now() - 5 * 86_400_000))
    seedAllTables(getDb(), new Date(Date.now() - 30 * 86_400_000))

    startBiometricsRetention({ initialDelayMs: 0, intervalHours: 24 })
    vi.advanceTimersByTime(0)

    // Only the 30-day-old rows should be pruned.
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
  })

  it('falls back to 24h when interval env is malformed', () => {
    process.env.BIOMETRICS_RETENTION_INTERVAL_HOURS = 'not-a-number'
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))

    startBiometricsRetention({ retentionDays: 30, initialDelayMs: 0 })
    vi.advanceTimersByTime(0)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)

    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    // Just under 24h — should NOT have fired again.
    vi.advanceTimersByTime(24 * 3_600_000 - 1)
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
    // Crossing 24h should fire.
    vi.advanceTimersByTime(1)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)
  })

  it('uses a valid interval from BIOMETRICS_RETENTION_INTERVAL_HOURS', () => {
    process.env.BIOMETRICS_RETENTION_INTERVAL_HOURS = '2'

    startBiometricsRetention({ retentionDays: 30, initialDelayMs: 0 })
    vi.advanceTimersByTime(0)

    expect(globalThis.setInterval).toHaveBeenCalledWith(expect.any(Function), 2 * 3_600_000)
  })

  it('falls back to 24h when intervalHours option is zero', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    startBiometricsRetention({
      retentionDays: 30,
      intervalHours: 0,
      initialDelayMs: 0,
    })
    vi.advanceTimersByTime(0)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)

    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    vi.advanceTimersByTime(24 * 3_600_000 - 1)
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)
  })

  it('logs a failed pass without crashing the timer loop', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    // retentionDays = NaN bypasses option default but trips runRetentionPass's
    // guard. Pass via env to exercise the catch arm.
    process.env.BIOMETRICS_RETENTION_DAYS = 'banana'

    startBiometricsRetention({ initialDelayMs: 0, intervalHours: 1 })
    vi.advanceTimersByTime(0)

    expect(err).toHaveBeenCalledWith(
      '[retention] pass failed:',
      expect.stringContaining('positive finite number'),
    )
  })

  it('stopBiometricsRetention clears a pending initial timer', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    startBiometricsRetention({
      retentionDays: 30,
      intervalHours: 1,
      initialDelayMs: 5_000,
    })
    stopBiometricsRetention()

    vi.advanceTimersByTime(60 * 60 * 1_000)
    // Nothing should have run.
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
  })

  it('stopBiometricsRetention clears the recurring interval after first pass', () => {
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    startBiometricsRetention({
      retentionDays: 30,
      intervalHours: 1,
      initialDelayMs: 0,
    })
    vi.advanceTimersByTime(0)
    expect(getDb().select().from(vitals).all()).toHaveLength(0)

    stopBiometricsRetention()
    seedAllTables(getDb(), new Date(Date.now() - 365 * 86_400_000))
    vi.advanceTimersByTime(10 * 3_600_000)
    expect(getDb().select().from(vitals).all()).toHaveLength(1)
  })

  it('stopBiometricsRetention is a no-op when nothing was started', () => {
    expect(() => stopBiometricsRetention()).not.toThrow()
  })
})
