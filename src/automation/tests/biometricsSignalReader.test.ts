import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import type { LatestCapSenseSnapshot } from '@/src/streaming/piezoStream'
import { BiometricsSignalReader } from '../signals.biometrics'
import { quietMechanicalSnapshot } from '@/src/biometrics/mechanical/tests/fixtures'

const state = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle<typeof schema>> | null,
  cap: null as LatestCapSenseSnapshot | null,
}))
vi.mock('@/src/db', () => ({
  get biometricsDb() {
    return state.db
  },
}))
vi.mock('@/src/streaming/piezoStream', () => ({ getLatestCapSenseSnapshot: () => state.cap }))

const NOW = new Date('2026-09-06T12:00:00Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)
let raw: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
const reader = new BiometricsSignalReader()

/** These scalar/freshness fixtures now carry synthetic, whole-window evidence. */
function qualifiedFixtureRead() {
  if (raw.open) {
    const now = Date.now(), snapshot = quietMechanicalSnapshot(now)
    snapshot.state.cleanSinceMs = now - 900000
    snapshot.spans[0].startMs = now - 900000
    raw.prepare('INSERT OR REPLACE INTO biometric_mechanical_state VALUES (1,?)').run(JSON.stringify(snapshot.state))
    raw.prepare('INSERT OR REPLACE INTO biometric_mechanical_spans VALUES (?,?,?,?)')
      .run(snapshot.spans[0].id, snapshot.state.epoch, now - 900000, now)
    for (const row of db.select().from(schema.vitals).all()) {
      if (row.processingRunId) continue
      const duration = Math.max(row.heartRate === null ? 0 : 30000, row.breathingRate === null ? 0 : 60000, row.hrv === null ? 0 : 300000)
      if (!duration) continue
      const run = randomUUID(), timestamp = row.timestamp.getTime()
      raw.prepare('INSERT INTO biometric_processing_runs (id,side,kind,bundle,config_hash,input_identity,started_at_ms) VALUES (?,?,\'live\',\'{}\',?,?,?)')
        .run(run, row.side, '0'.repeat(64), JSON.stringify({ sourceSide: row.side, timestampBasis: 'firmware_event_time_v1', mechanicalContext: 'mechanical-context-v1' }), timestamp - duration)
      raw.prepare('UPDATE vitals SET processing_run_id=? WHERE id=?').run(run, row.id)
      raw.prepare('INSERT INTO vitals_quality (vitals_id,side,timestamp,quality_score,flags,created_at) VALUES (?,?,?,0.9,?,?)')
        .run(row.id, row.side, timestamp / 1000, JSON.stringify([`mechanical_context_v1:${snapshot.state.epoch}:${snapshot.state.spanId}:${timestamp - duration - 1000}:${timestamp + 1000}`]), now / 1000)
    }
  }
  return reader.read()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  raw = new Database(':memory:')
  db = drizzle(raw, { schema })
  migrate(db, { migrationsFolder: path.resolve('src/db/biometrics-migrations') })
  state.db = db
  state.cap = null
})
afterEach(() => {
  if (raw.open) raw.close()
  state.db = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function seedEnvironment(timestamp: Date) {
  db.insert(schema.bedTemp).values({
    timestamp, ambientTemp: 2000, humidity: 4500,
    leftOuterTemp: 1000, leftCenterTemp: 2000, leftInnerTemp: 3000,
    rightOuterTemp: 3000, rightCenterTemp: 2000, rightInnerTemp: 1000,
  }).run()
  db.insert(schema.freezerTemp).values({ timestamp, leftWaterTemp: 0, rightWaterTemp: 4000 }).run()
  db.insert(schema.ambientLight).values({ timestamp, lux: 0 }).run()
}

const environment = {
  'ambient.temperature': 68, 'ambient.humidity': 45, 'ambient.light': 0,
  'left.surfaceTemp': 68, 'left.surfaceTemp.spread': 36, 'left.surfaceTemp.gradient': 36,
  'right.surfaceTemp': 68, 'right.surfaceTemp.spread': 36, 'right.surfaceTemp.gradient': -36,
  'left.waterTemp': 32, 'right.waterTemp': 104,
}

describe('BiometricsSignalReader', () => {
  it('withholds a fresh legacy row without inventing mechanical qualification', () => {
    db.insert(schema.vitals).values({ side: 'left', timestamp: ago(2000), heartRate: 60 }).run()
    expect(reader.read()).toEqual({})
  })
  it('returns no signals before any samples arrive', () => {
    expect(qualifiedFixtureRead()).toEqual({})
  })

  it('selects the newest row independently for each side and source', () => {
    // Insert older rows last: an unordered query must not accidentally pass.
    for (const [side, heartRate, totalMovement] of [['left', 61, 0], ['right', 72, 15]] as const) {
      db.insert(schema.vitals).values([
        { side, timestamp: ago(2000), heartRate, hrv: 40, breathingRate: 12 },
        { side, timestamp: ago(60_000), heartRate: 99, hrv: 99, breathingRate: 99 },
      ]).run()
      db.insert(schema.movement).values([
        { side, timestamp: NOW, totalMovement },
        { side, timestamp: ago(60_000), totalMovement: 99 },
      ]).run()
    }
    expect(qualifiedFixtureRead()).toEqual({
      'left.heartRate': 61, 'left.hrv': 40, 'left.breathingRate': 12, 'left.movement': 0,
      'right.heartRate': 72, 'right.hrv': 40, 'right.breathingRate': 12, 'right.movement': 15,
    })
  })

  it('keeps zero vitals but does not resurrect missing values from older rows', () => {
    db.insert(schema.vitals).values([
      { side: 'left', timestamp: ago(2000), heartRate: 0, hrv: 0, breathingRate: 0 },
      { side: 'right', timestamp: NOW },
      { side: 'right', timestamp: ago(1000), heartRate: 65, hrv: 30, breathingRate: 14 },
    ]).run()
    expect(qualifiedFixtureRead()).toEqual({ 'left.heartRate': 0, 'left.hrv': 0, 'left.breathingRate': 0 })
  })

  it.each([0, 1])('expires vitals and movement %i ms past their five-minute boundary', (extra) => {
    db.insert(schema.vitals).values({ side: 'left', timestamp: ago(300_000), heartRate: 60 }).run()
    db.insert(schema.movement).values({ side: 'right', timestamp: ago(300_000), totalMovement: 7 }).run()
    vi.setSystemTime(NOW.getTime() + extra)
    expect(qualifiedFixtureRead()).toEqual(extra ? {} : { 'left.heartRate': 60, 'right.movement': 7 })
  })

  it.each([0, 1])('expires all environment sources %i ms past their fifteen-minute boundary', (extra) => {
    seedEnvironment(ago(900_000))
    vi.setSystemTime(NOW.getTime() + extra)
    expect(qualifiedFixtureRead()).toEqual(extra ? {} : environment)
  })

  it('uses the newest environment rows even when they contain missing readings', () => {
    seedEnvironment(ago(1000))
    db.insert(schema.bedTemp).values({ timestamp: NOW }).run()
    db.insert(schema.freezerTemp).values({ timestamp: NOW }).run()
    db.insert(schema.ambientLight).values({ timestamp: NOW }).run()
    expect(qualifiedFixtureRead()).toEqual({})
  })

  it('averages only available surface zones and requires both endpoints for a gradient', () => {
    db.insert(schema.bedTemp).values({
      timestamp: NOW, leftCenterTemp: 0, rightOuterTemp: 1000, rightCenterTemp: 3000,
    }).run()
    expect(qualifiedFixtureRead()).toEqual({
      'left.surfaceTemp': 32, 'right.surfaceTemp': 68, 'right.surfaceTemp.spread': 36,
    })
  })

  it('computes a gradient when the center is missing and keeps independent nullable water readings', () => {
    db.insert(schema.bedTemp).values({ timestamp: NOW, leftOuterTemp: 3000, leftInnerTemp: 1000 }).run()
    db.insert(schema.freezerTemp).values({ timestamp: NOW, rightWaterTemp: 0 }).run()
    expect(qualifiedFixtureRead()).toEqual({
      'left.surfaceTemp': 68, 'left.surfaceTemp.spread': 36, 'left.surfaceTemp.gradient': -36,
      'right.waterTemp': 32,
    })
  })

  it('drops stale sources without suppressing fresh sources on either side', () => {
    seedEnvironment(ago(901_000))
    db.insert(schema.vitals).values({ side: 'left', timestamp: ago(301_000), heartRate: 60 }).run()
    db.insert(schema.vitals).values({ side: 'right', timestamp: ago(2000), heartRate: 70 }).run()
    db.insert(schema.movement).values({ side: 'left', timestamp: NOW, totalMovement: 3 }).run()
    expect(qualifiedFixtureRead()).toEqual({ 'right.heartRate': 70, 'left.movement': 3 })
  })

  it('rejects future stored observations rather than resurrecting an older reading', () => {
    seedEnvironment(NOW)
    const future = new Date(NOW.getTime() + 1000)
    seedEnvironment(future)
    db.insert(schema.vitals).values([
      { side: 'left', timestamp: NOW, heartRate: 65 },
      { side: 'left', timestamp: future, heartRate: 90 },
    ]).run()
    db.insert(schema.movement).values({ side: 'right', timestamp: future, totalMovement: 10 }).run()
    expect(qualifiedFixtureRead()).toEqual({})
  })

  it('reduces capSense2 body channels without including the two reference channels', () => {
    state.cap = {
      type: 'capSense2', ts: NOW.getTime() / 1000, receivedAtMs: NOW.getTime(),
      left: [1, 2, 3, 4, 5, 6, 999, -999], right: [10, 20, 30, 40, 50, 60, 9999, -9999],
    }
    expect(qualifiedFixtureRead()).toEqual({
      'left.cap.max': 6, 'left.cap.mean': 3.5, 'left.cap.spread': 5,
      'right.cap.max': 60, 'right.cap.mean': 35, 'right.cap.spread': 50,
    })
  })

  it.each([0, 1])('expires scalar capSense %i ms past receipt freshness with a current firmware timestamp', (extra) => {
    state.cap = { type: 'capSense', ts: NOW.getTime() / 1000, receivedAtMs: NOW.getTime() - 30_000, left: 0, right: 12 }
    vi.setSystemTime(NOW.getTime() + extra)
    expect(qualifiedFixtureRead()).toEqual(extra
      ? {}
      : {
          'left.cap.max': 0, 'left.cap.mean': 0, 'left.cap.spread': 0,
          'right.cap.max': 12, 'right.cap.mean': 12, 'right.cap.spread': 0,
        })
  })

  it('omits empty capacitive arrays independently by side', () => {
    state.cap = { type: 'capSense2', ts: NOW.getTime() / 1000, receivedAtMs: NOW.getTime(), left: [], right: [4, 6] }
    expect(qualifiedFixtureRead()).toEqual({ 'right.cap.max': 6, 'right.cap.mean': 5, 'right.cap.spread': 2 })
  })

  it('warns and returns an empty snapshot if the database is unavailable', () => {
    raw.close()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(qualifiedFixtureRead()).toEqual({})
    expect(warn).toHaveBeenCalledWith('[automation] BiometricsSignalReader.read failed:', expect.any(Error))
  })

  it('retains signals already read when a later source fails', () => {
    db.insert(schema.vitals).values({ side: 'left', timestamp: ago(2000), heartRate: 63 }).run()
    raw.exec('DROP TABLE movement')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(qualifiedFixtureRead()).toEqual({ 'left.heartRate': 63 })
    expect(warn).toHaveBeenCalledOnce()
  })
})
