/**
 * getWatchMotionSeries against a real in-memory biometrics.db, fed through the
 * same parse/save path as POST /api/biometrics/watch-motion.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { parseWatchMotion, saveWatchMotion } from '@/src/biometrics/references/watch-motion'

const dbHolder = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/src/db', () => ({
  db: {},
  get biometricsDb() { return dbHolder.current },
}))
vi.mock('@/src/server/routers/raw', () => ({ listRawFiles: vi.fn(async () => []) }))
vi.mock('@/src/lib/occupancy', () => ({ getOccupancy: vi.fn() }))

const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const caller = biometricsRouter.createCaller({})

const T = Date.UTC(2026, 10, 2, 6)
const M = 60_000
let raw: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>

beforeEach(() => {
  raw = new Database(':memory:')
  db = drizzle(raw, { schema })
  migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
  dbHolder.current = db
})
afterEach(() => raw.close())

it('returns per-minute Watch movement for the side, with gaps left out', async () => {
  const starts = [T, T + 2000, T + 10 * M]
  saveWatchMotion(db, 'left', parseWatchMotion(JSON.stringify({
    version: 'watch-motion-v1', recordedFromMs: T, recordedToMs: T + 11 * M, timeZone: 'UTC', utcOffsetSeconds: 0, sampleRateHz: 50,
    binSeconds: 2, jerkThresholdGPerSecond: 1, device: 'test',
    bins: { startMs: starts, samples: [100, 100, 50], meanMagnitude: [1, 1, 1], magnitudeVariance: [0.002, 0.004, 0.01], maxJerk: [0.5, 2, 1], movingSamples: [1, 3, 0] },
  })))
  const rows = await caller.getWatchMotionSeries({ side: 'left', startDate: new Date(T - M), endDate: new Date(T + 20 * M) })
  expect(rows).toEqual([
    { timestamp: new Date(T), movingSamples: 4, maxJerk: 2, meanVariance: 0.003, samples: 200 },
    { timestamp: new Date(T + 10 * M), movingSamples: 0, maxJerk: 1, meanVariance: 0.01, samples: 50 },
  ])
  expect(await caller.getWatchMotionSeries({ side: 'right', startDate: new Date(T), endDate: new Date(T + 20 * M) })).toEqual([])
})

it('rejects inverted and over-long windows', async () => {
  await expect(caller.getWatchMotionSeries({ side: 'left', startDate: new Date(T), endDate: new Date(T - 1) })).rejects.toThrow(/startDate/)
  await expect(caller.getWatchMotionSeries({ side: 'left', startDate: new Date(T), endDate: new Date(T + 32 * 24 * 60 * M) })).rejects.toThrow(/31 days/)
})
