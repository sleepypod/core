import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '../biometrics-schema'
import {
  ambientLight,
  bedTemp,
  flowReadings,
  freezerTemp,
  movement,
  vitals,
  waterLevelReadings,
} from '../biometrics-schema'
import { pruneOldBiometrics } from '../retention'

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

    const result = pruneOldBiometrics(cutoff, db)

    expect(result.rowsDeleted).toBe(7)
    expect(result.perTable).toEqual({
      vitals: 1,
      movement: 1,
      bed_temp: 1,
      freezer_temp: 1,
      flow_readings: 1,
      ambient_light: 1,
      water_level_readings: 1,
    })

    // Verify fresh rows remain
    expect(db.select().from(vitals).all()).toHaveLength(1)
    expect(db.select().from(movement).all()).toHaveLength(1)
    expect(db.select().from(bedTemp).all()).toHaveLength(1)
    expect(db.select().from(freezerTemp).all()).toHaveLength(1)
    expect(db.select().from(flowReadings).all()).toHaveLength(1)
    expect(db.select().from(ambientLight).all()).toHaveLength(1)
    expect(db.select().from(waterLevelReadings).all()).toHaveLength(1)
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

  it('leaves vitals_quality untouched (current explicit exclusion)', () => {
    // vitals_quality.vitals_id logically references vitals.id but no FK is
    // enforced. pruneOldBiometrics deletes vitals but excludes vitals_quality,
    // so quality rows pointing at deleted vitals become permanent orphans.
    // This test documents the current behavior; follow-up to either include
    // vitals_quality in the prune set or implement cascade-delete is tracked
    // in the PR description.
    const old = new Date('2020-01-01T00:00:00Z')
    const inserted = db.insert(vitals).values({
      side: 'left', timestamp: old, heartRate: 60,
    }).returning({ id: vitals.id }).all()
    const vitalsId = inserted[0].id
    db.insert(schema.vitalsQuality).values({
      vitalsId,
      side: 'left',
      timestamp: old,
      qualityScore: 0.8,
    }).run()

    const result = pruneOldBiometrics(new Date('2026-01-01T00:00:00Z'), db)

    expect(result.rowsDeleted).toBeGreaterThan(0)
    expect(db.select().from(vitals).all()).toHaveLength(0)
    // The orphan survives — call this out so the next iteration of retention
    // policy explicitly handles it.
    expect(db.select().from(schema.vitalsQuality).all()).toHaveLength(1)
  })
})
