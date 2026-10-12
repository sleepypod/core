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
import { referenceVitals, vitals } from '@/src/db/biometrics-schema'

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
