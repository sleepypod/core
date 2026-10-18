/**
 * importReferenceVitals / getReferenceVitals against a real in-memory
 * biometrics.db with the migrations applied, so idempotency is exercised
 * through the actual unique index rather than a mocked insert.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { referenceSamples, referenceVitals, vitals } from '@/src/db/biometrics-schema'
import { ReferenceStore } from '@/src/biometrics/references/store'

type Db = ReturnType<typeof drizzle<typeof schema>>

const dbHolder = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('@/src/db', () => ({
  db: {},
  get biometricsDb() { return dbHolder.current },
}))
vi.mock('@/src/server/routers/raw', () => ({ listRawFiles: vi.fn(async () => []) }))
vi.mock('@/src/lib/occupancy', () => ({ getOccupancy: vi.fn() }))

const { biometricsRouter } = await import('@/src/server/routers/biometrics')
const caller = biometricsRouter.createCaller({})

// 2026-10-10 23:00:00 UTC, unix seconds
const T0 = 1791673200
const MIN = 60

const samples = [
  { timestamp: T0, heartRate: 58 },
  { timestamp: T0 + 5 * MIN, heartRate: 56.5 },
  { timestamp: T0 + 10 * MIN, heartRate: 61 },
]

describe('biometrics reference vitals', () => {
  let raw: Database.Database
  let db: Db

  beforeEach(() => {
    raw = new Database(':memory:')
    db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
    dbHolder.current = db
  })

  afterEach(() => raw.close())

  it('records new legacy rows through the normalized service with limited provenance', async () => {
    await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples: samples })
    expect(raw.prepare('SELECT count(*) AS total FROM reference_imports').get()).toEqual({ total: 1 })
    expect(raw.prepare('SELECT count(*) AS total FROM reference_measurements').get()).toEqual({ total: samples.length })
    expect(raw.prepare('SELECT count(*) AS total FROM reference_vitals WHERE import_id IS NOT NULL').get()).toEqual({ total: samples.length })
    expect(db.select().from(schema.referenceImports).get()?.subjectId).toBe('legacy_unknown:left')
  })

  it('rolls back legacy writes if normalized provenance cannot be saved', async () => {
    raw.exec('CREATE TRIGGER fail_reference BEFORE INSERT ON reference_measurements BEGIN SELECT RAISE(ABORT, \'disk full\'); END')
    await expect(caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples: samples })).rejects.toThrow()
    expect(raw.prepare('SELECT count(*) AS total FROM reference_vitals').get()).toEqual({ total: 0 })
    expect(raw.prepare('SELECT count(*) AS total FROM reference_imports').get()).toEqual({ total: 0 })
  })

  describe('importReferenceVitals', () => {
    it('writes every sample with second-resolution timestamps', async () => {
      const out = await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      expect(out).toEqual({ written: 3 })
      const rows = raw.prepare('SELECT side, source, timestamp, heart_rate FROM reference_vitals ORDER BY timestamp').all()
      expect(rows).toEqual(samples.map(s => ({ side: 'left', source: 'apple_watch', timestamp: s.timestamp, heart_rate: s.heartRate })))
    })

    it('is a no-op when the same samples are posted again', async () => {
      await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      const again = await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      expect(again).toEqual({ written: 0 })
      expect(db.select().from(referenceVitals).all()).toHaveLength(3)
    })

    it('writes only the new samples when a repost extends the night', async () => {
      await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      const out = await caller.importReferenceVitals({
        side: 'left',
        source: 'apple_watch',
        samples: [...samples, { timestamp: T0 + 15 * MIN, heartRate: 59 }],
      })
      expect(out).toEqual({ written: 1 })
    })

    it('keeps sides apart', async () => {
      await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      const out = await caller.importReferenceVitals({ side: 'right', source: 'apple_watch', samples })
      expect(out).toEqual({ written: 3 })
      expect(db.select().from(referenceVitals).all()).toHaveLength(6)
    })

    it('never touches the pod vitals table', async () => {
      await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      expect(db.select().from(vitals).all()).toHaveLength(0)
    })

    it('rejects millisecond timestamps, implausible heart rates, and unknown sources', async () => {
      await expect(caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples: [{ timestamp: T0 * 1000, heartRate: 60 }] })).rejects.toThrow()
      await expect(caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples: [{ timestamp: T0, heartRate: 10 }] })).rejects.toThrow()
      await expect(caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples: [{ timestamp: T0, heartRate: 300 }] })).rejects.toThrow()
      await expect(caller.importReferenceVitals({ side: 'left', source: 'fitbit' as never, samples })).rejects.toThrow()
      await expect(caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples: [] })).rejects.toThrow()
    })

    it('surfaces a database failure as INTERNAL_SERVER_ERROR', async () => {
      raw.exec('DROP TABLE reference_vitals')
      await expect(caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples }))
        .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: /Failed to import reference vitals/ })
    })
  })

  describe('importReferenceSamples', () => {
    const breathing = [{ timestamp: T0, value: 14.5 }, { timestamp: T0 + 5 * MIN, value: 15 }]

    it('stores breathing rate and HRV per metric with normalized provenance', async () => {
      expect(await caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'breathing_rate', samples: breathing })).toEqual({ written: 2 })
      // Same second as a breathing sample: each metric keeps its own row.
      expect(await caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'hrv_sdnn', samples: [{ timestamp: T0, value: 48 }] })).toEqual({ written: 1 })
      expect(raw.prepare('SELECT metric, timestamp, value FROM reference_samples ORDER BY metric, timestamp').all()).toEqual([
        { metric: 'breathing_rate', timestamp: T0, value: 14.5 },
        { metric: 'breathing_rate', timestamp: T0 + 5 * MIN, value: 15 },
        { metric: 'hrv_sdnn', timestamp: T0, value: 48 },
      ])
      expect(raw.prepare('SELECT metric, unit, value FROM reference_measurements ORDER BY metric, start_ms').all()).toEqual([
        { metric: 'breathing_rate', unit: 'breaths/min', value: 14.5 },
        { metric: 'breathing_rate', unit: 'breaths/min', value: 15 },
        { metric: 'hrv_sdnn', unit: 'ms', value: 48 },
      ])
      expect(raw.prepare('SELECT count(*) AS total FROM reference_samples WHERE import_id IS NULL').get()).toEqual({ total: 0 })
      expect(db.select().from(vitals).all()).toHaveLength(0)
    })

    it('is a no-op on repost and writes only new samples when a repost extends the night', async () => {
      await caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'breathing_rate', samples: breathing })
      expect(await caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'breathing_rate', samples: breathing })).toEqual({ written: 0 })
      expect(await caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'breathing_rate',
        samples: [...breathing, { timestamp: T0 + 10 * MIN, value: 16 }] })).toEqual({ written: 1 })
      expect(await caller.importReferenceSamples({ side: 'right', source: 'apple_watch', metric: 'breathing_rate', samples: breathing })).toEqual({ written: 2 })
      expect(db.select().from(referenceSamples).all()).toHaveLength(5)
      expect(raw.prepare('SELECT count(*) AS total FROM reference_imports').get()).toEqual({ total: 3 })
    })

    it('rejects implausible values per metric, unknown metrics and millisecond timestamps', async () => {
      const post = (metric: 'breathing_rate' | 'hrv_sdnn', timestamp: number, value: number) =>
        caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric, samples: [{ timestamp, value }] })
      await expect(post('breathing_rate', T0, 2)).rejects.toThrow()
      await expect(post('breathing_rate', T0, 80)).rejects.toThrow()
      await expect(post('hrv_sdnn', T0, 0)).rejects.toThrow()
      await expect(post('hrv_sdnn', T0, 600)).rejects.toThrow()
      await expect(post('hrv_sdnn', T0 * 1000, 40)).rejects.toThrow()
      await expect(post('heart_rate' as never, T0, 60)).rejects.toThrow()
      expect(await post('hrv_sdnn', T0, 250)).toEqual({ written: 1 })
    })

    it('deletes the samples with their reference import', async () => {
      await caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'hrv_sdnn', samples: [{ timestamp: T0, value: 48 }] })
      const importId = db.select().from(referenceSamples).get()?.importId
      expect(importId).toBeTruthy()
      new ReferenceStore(db).delete(importId as string)
      expect(db.select().from(referenceSamples).all()).toHaveLength(0)
    })

    it('surfaces a database failure as INTERNAL_SERVER_ERROR', async () => {
      raw.exec('DROP TABLE reference_samples')
      await expect(caller.importReferenceSamples({ side: 'left', source: 'apple_watch', metric: 'breathing_rate', samples: breathing }))
        .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: /Failed to import reference samples/ })
    })
  })

  describe('getReferenceVitals', () => {
    beforeEach(async () => {
      await caller.importReferenceVitals({ side: 'left', source: 'apple_watch', samples })
      await caller.importReferenceVitals({ side: 'right', source: 'apple_watch', samples: [{ timestamp: T0, heartRate: 70 }] })
    })

    it('returns the side’s samples inside the inclusive window, oldest first', async () => {
      const out = await caller.getReferenceVitals({
        side: 'left',
        startDate: new Date(T0 * 1000),
        endDate: new Date((T0 + 5 * MIN) * 1000),
      })
      expect(out.map(r => [r.timestamp.getTime() / 1000, r.heartRate])).toEqual([[T0, 58], [T0 + 5 * MIN, 56.5]])
      expect(out[0].source).toBe('apple_watch')
      expect(out[0].side).toBe('left')
    })

    it('excludes samples outside the window and from the other side', async () => {
      const out = await caller.getReferenceVitals({
        side: 'right',
        startDate: new Date((T0 + 1) * 1000),
        endDate: new Date((T0 + 60 * MIN) * 1000),
      })
      expect(out).toEqual([])
    })

    it('keeps the newest samples, oldest first, when the window exceeds the limit', async () => {
      const out = await caller.getReferenceVitals({
        side: 'left',
        startDate: new Date(T0 * 1000),
        endDate: new Date((T0 + 60 * MIN) * 1000),
        limit: 2,
      })
      expect(out.map(r => r.timestamp.getTime() / 1000)).toEqual([T0 + 5 * MIN, T0 + 10 * MIN])
    })

    it('rejects a reversed window', async () => {
      await expect(caller.getReferenceVitals({
        side: 'left',
        startDate: new Date((T0 + 60 * MIN) * 1000),
        endDate: new Date(T0 * 1000),
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })

    it('surfaces a database failure as INTERNAL_SERVER_ERROR', async () => {
      raw.exec('DROP TABLE reference_vitals')
      await expect(caller.getReferenceVitals({
        side: 'left',
        startDate: new Date(T0 * 1000),
        endDate: new Date((T0 + 60 * MIN) * 1000),
      })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: /Failed to fetch reference vitals/ })
    })
  })
})
