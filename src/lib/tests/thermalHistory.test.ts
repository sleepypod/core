import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { bucketSecondsFor, getThermalHistory } from '../thermalHistory'

const NOW = new Date('2026-09-28T18:00:00Z').getTime()
const sec = (ms: number) => new Date(Math.floor(ms / 1000) * 1000)
const minutesAgo = (m: number) => sec(NOW - m * 60_000)

let raw: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>

beforeEach(() => {
  raw = new Database(':memory:')
  db = drizzle(raw, { schema })
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
})

afterEach(() => raw.close())

describe('bucketSecondsFor', () => {
  it('never goes below a minute and keeps 7 days under ~360 buckets', () => {
    expect(bucketSecondsFor('1h')).toBe(60)
    expect(bucketSecondsFor('12h')).toBe(120)
    expect(Math.ceil(604_800 / bucketSecondsFor('7d'))).toBeLessThanOrEqual(360)
  })
})

describe('getThermalHistory', () => {
  it('averages each table into shared buckets and converts centidegrees to °F', () => {
    db.insert(schema.bedTemp).values([
      { timestamp: minutesAgo(10), leftCenterTemp: 2500, rightCenterTemp: 2600 },
      { timestamp: minutesAgo(10), leftCenterTemp: 2600, rightCenterTemp: 2600 },
    ]).onConflictDoNothing().run()
    db.insert(schema.freezerTemp).values({ timestamp: minutesAgo(10), leftWaterTemp: 2000, rightWaterTemp: 3000, heatsinkTemp: 2400, ambientTemp: 2200 }).run()
    db.insert(schema.flowReadings).values({ timestamp: minutesAgo(10), leftPumpRpm: 1947, rightPumpRpm: 2207 }).run()
    db.insert(schema.thermalState).values([
      { timestamp: minutesAgo(10), side: 'left', isPowered: true, targetTempF: 80, currentTempF: 79 },
      { timestamp: minutesAgo(10), side: 'right', isPowered: false },
    ]).run()

    const h = getThermalHistory(db as never, '1h', NOW)
    expect(h.points).toHaveLength(1)
    const [p] = h.points
    expect(p).toMatchObject({
      leftSurface: 77, // 25.0°C (duplicate timestamp ignored by the unique index)
      rightSurface: 78.8,
      leftWater: 68,
      rightWater: 86,
      heatsink: 75.2,
      ambient: 71.6,
      leftRpm: 1947,
      rightRpm: 2207,
      leftTarget: 80,
      leftBed: 79,
      rightTarget: null,
      rightBed: null,
    })
    expect(h.available).toEqual({ bedTarget: true, water: true, surface: true, pump: true, hub: true })
  })

  it('leaves rows outside the window out and flags empty panels', () => {
    db.insert(schema.flowReadings).values({ timestamp: minutesAgo(120), leftPumpRpm: 100, rightPumpRpm: 100 }).run()
    const h = getThermalHistory(db as never, '1h', NOW)
    expect(h.points).toEqual([])
    expect(h.available.pump).toBe(false)
    expect(h.bedTargetSince).toBeNull()
  })

  it('finds off→on transitions, using the row before the window as context', () => {
    db.insert(schema.thermalState).values([
      { timestamp: minutesAgo(90), side: 'left', isPowered: true, targetTempF: 80 },
      { timestamp: minutesAgo(50), side: 'left', isPowered: true, targetTempF: 80 },
      { timestamp: minutesAgo(40), side: 'left', isPowered: false },
      { timestamp: minutesAgo(20), side: 'left', isPowered: true, targetTempF: 82 },
      { timestamp: minutesAgo(30), side: 'right', isPowered: true, targetTempF: 78 },
    ]).run()
    const h = getThermalHistory(db as never, '1h', NOW)
    // Left was already on before the window (not a transition), then turned on again 20 min ago.
    expect(h.powerOn).toEqual([
      { side: 'right', at: minutesAgo(30).getTime() },
      { side: 'left', at: minutesAgo(20).getTime() },
    ])
    expect(h.bedTargetSince).toBe(minutesAgo(90).getTime())
  })

  it('adds the current session start from device_state when recording missed it', () => {
    const on = NOW - 15 * 60_000
    const h = getThermalHistory(db as never, '1h', NOW, { left: on, right: null })
    expect(h.powerOn).toEqual([{ side: 'left', at: on }])
  })
})
