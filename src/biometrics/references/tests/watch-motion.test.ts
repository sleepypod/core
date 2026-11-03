// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { canonicalJson, parseWatchMotion, saveWatchMotion, watchMotionMinutes, watchMotionSeries, type WatchMotionFile } from '../watch-motion'

const M = 60_000
const T = Date.UTC(2026, 10, 2, 6) // minute-aligned

function file(starts: number[], moving: number[], from = starts[0], to = starts[starts.length - 1] + 2000): WatchMotionFile {
  return {
    version: 'watch-motion-v1', recordedFromMs: from, recordedToMs: to, timeZone: 'UTC', utcOffsetSeconds: 0, sampleRateHz: 50,
    binSeconds: 2, jerkThresholdGPerSecond: 1, device: 'test',
    bins: { startMs: starts, samples: starts.map(() => 100), meanMagnitude: starts.map(() => 1),
      magnitudeVariance: starts.map((_, i) => (i + 1) * 0.001), maxJerk: starts.map((_, i) => i), movingSamples: moving },
  }
}

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
})
afterEach(() => sqlite.close())

it('sums bins per minute and leaves minutes without bins absent', () => {
  const starts = [T, T + 2000, T + 58_000, T + 3 * M]
  const rows = watchMotionMinutes([file(starts, [1, 2, 3, 4])], T, T + 10 * M)
  expect(rows).toEqual([
    { timestamp: new Date(T), movingSamples: 6, maxJerk: 2, meanVariance: 0.002, samples: 300 },
    { timestamp: new Date(T + 3 * M), movingSamples: 4, maxJerk: 3, meanVariance: 0.004, samples: 100 },
  ])
})

it('keeps only bins starting inside the window and counts overlapping captures once', () => {
  const a = file([T, T + 2000, T + M], [1, 1, 1])
  const b = file([T + M, T + 2 * M], [5, 5])
  expect(watchMotionMinutes([b, a], T + 2000, T + 2 * M).map(r => [r.timestamp.getTime(), r.movingSamples]))
    .toEqual([[T, 1], [T + M, 1], [T + 2 * M, 5]])
})

it('canonicalizes with sorted keys and hashes the trimmed file', () => {
  expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 3 } })).toBe('{"a":{"c":3,"d":[2,{"y":2,"z":1}]},"b":1}')
  const original = file([T - 24 * 3600_000, T, T + 2000], [9, 1, 2], T + 500, T + M)
  const parsed = parseWatchMotion(JSON.stringify(original))
  expect(parsed.trimmedBins).toBe(1)
  expect(parsed.file.bins.startMs).toEqual([T, T + 2000])
  expect(parsed.file.bins.movingSamples).toEqual([1, 2])
  expect(parseWatchMotion(parsed.canonical).sha256).toBe(parsed.sha256)
})

it('serves the series for one side from overlapping captures only', () => {
  const night = file([T, T + M, T + 5 * M], [3, 4, 5], T, T + 6 * M)
  saveWatchMotion(db, 'left', parseWatchMotion(JSON.stringify(night)))
  saveWatchMotion(db, 'right', parseWatchMotion(JSON.stringify(file([T], [99], T, T + M))))
  expect(watchMotionSeries(db, 'left', new Date(T + M), new Date(T + 10 * M)).map(r => [r.timestamp.getTime(), r.movingSamples]))
    .toEqual([[T + M, 4], [T + 5 * M, 5]])
  expect(watchMotionSeries(db, 'left', new Date(T + 7 * M), new Date(T + 10 * M))).toEqual([])
  expect(watchMotionSeries(db, 'right', new Date(T), new Date(T + M)).map(r => r.movingSamples)).toEqual([99])
})
