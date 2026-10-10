/**
 * importReferenceStages / getReferenceStages against a real in-memory
 * biometrics.db with the migrations applied, so idempotency is exercised
 * through the actual unique index rather than a mocked insert.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { referenceStages } from '@/src/db/biometrics-schema'

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

// 2026-10-09 23:00:00 UTC, unix seconds
const T0 = 1791673200
const MIN = 60

const night = [
  { start: T0, end: T0 + 20 * MIN, stage: 'light' as const },
  { start: T0 + 20 * MIN, end: T0 + 50 * MIN, stage: 'deep' as const },
  { start: T0 + 50 * MIN, end: T0 + 70 * MIN, stage: 'rem' as const },
  { start: T0 + 70 * MIN, end: T0 + 72 * MIN, stage: 'wake' as const },
]

describe('biometrics reference stages', () => {
  let raw: Database.Database
  let db: Db

  beforeEach(() => {
    raw = new Database(':memory:')
    db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/biometrics-migrations') })
    dbHolder.current = db
  })

  afterEach(() => raw.close())

  describe('importReferenceStages', () => {
    it('writes every segment with second-resolution timestamps', async () => {
      const out = await caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night })
      expect(out).toEqual({ written: 4 })

      const rows = raw.prepare('SELECT side, source, start, "end", stage FROM reference_stages ORDER BY start').all()
      expect(rows).toEqual(night.map(s => ({ side: 'left', source: 'apple_watch', ...s })))
    })

    it('is a no-op when the same night is posted again', async () => {
      await caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night })
      const again = await caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night })

      expect(again).toEqual({ written: 0 })
      expect(db.select().from(referenceStages).all()).toHaveLength(4)
    })

    it('keeps the first write when a repost changes an existing segment', async () => {
      await caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night })
      const out = await caller.importReferenceStages({
        side: 'left',
        source: 'apple_watch',
        segments: [{ start: T0, end: T0 + 25 * MIN, stage: 'wake' }, { start: T0 + 72 * MIN, end: T0 + 90 * MIN, stage: 'light' }],
      })

      expect(out).toEqual({ written: 1 })
      const first = db.select().from(referenceStages).all().find(r => r.start.getTime() === T0 * 1000)
      expect(first?.stage).toBe('light')
      expect(first?.end.getTime()).toBe((T0 + 20 * MIN) * 1000)
    })

    it('stores the same start separately per side', async () => {
      await caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night })
      const out = await caller.importReferenceStages({ side: 'right', source: 'apple_watch', segments: night })

      expect(out).toEqual({ written: 4 })
      expect(db.select().from(referenceStages).all()).toHaveLength(8)
    })

    it('rejects a segment whose end is not after its start', async () => {
      for (const end of [T0, T0 - 1]) {
        await expect(caller.importReferenceStages({
          side: 'left',
          source: 'apple_watch',
          segments: [night[0], { start: T0, end, stage: 'light' }],
        })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
      }
      expect(db.select().from(referenceStages).all()).toHaveLength(0)
    })

    it.each([
      ['unknown stage', { side: 'left', source: 'apple_watch', segments: [{ start: T0, end: T0 + MIN, stage: 'awake' }] }],
      ['unknown source', { side: 'left', source: 'oura', segments: [{ start: T0, end: T0 + MIN, stage: 'light' }] }],
      ['unknown side', { side: 'middle', source: 'apple_watch', segments: [{ start: T0, end: T0 + MIN, stage: 'light' }] }],
      ['empty segments', { side: 'left', source: 'apple_watch', segments: [] }],
      ['fractional timestamp', { side: 'left', source: 'apple_watch', segments: [{ start: T0 + 0.5, end: T0 + MIN, stage: 'light' }] }],
      ['non-positive timestamp', { side: 'left', source: 'apple_watch', segments: [{ start: 0, end: MIN, stage: 'light' }] }],
      ['extra segment key', { side: 'left', source: 'apple_watch', segments: [{ start: T0, end: T0 + MIN, stage: 'light', value: 3 }] }],
      ['extra top-level key', { side: 'left', source: 'apple_watch', segments: [{ start: T0, end: T0 + MIN, stage: 'light' }], night: '10-09' }],
    ])('rejects %s', async (_label, input) => {
      await expect(caller.importReferenceStages(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })

    it('rejects more than 2000 segments in one post', async () => {
      const segments = Array.from({ length: 2001 }, (_, i) => ({ start: T0 + i * MIN, end: T0 + (i + 1) * MIN, stage: 'light' as const }))
      await expect(caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments }))
        .rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })

    it('wraps database failures as INTERNAL_SERVER_ERROR', async () => {
      raw.close()
      await expect(caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night }))
        .rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: expect.stringContaining('Failed to import reference stages') })
      raw = new Database(':memory:')
    })
  })

  describe('getReferenceStages', () => {
    beforeEach(async () => {
      await caller.importReferenceStages({ side: 'left', source: 'apple_watch', segments: night })
      await caller.importReferenceStages({ side: 'right', source: 'apple_watch', segments: [{ start: T0, end: T0 + 30 * MIN, stage: 'deep' }] })
    })

    it('reads back what was imported for the side, oldest first', async () => {
      const rows = await caller.getReferenceStages({
        side: 'left',
        startDate: new Date((T0 - 60 * MIN) * 1000),
        endDate: new Date((T0 + 120 * MIN) * 1000),
      })

      expect(rows.map(r => ({ start: r.start.getTime() / 1000, end: r.end.getTime() / 1000, stage: r.stage }))).toEqual(night)
      expect(rows.every(r => r.side === 'left' && r.source === 'apple_watch')).toBe(true)
      expect(rows[0].createdAt).toBeInstanceOf(Date)
    })

    it('includes segments that only partly overlap the window', async () => {
      const rows = await caller.getReferenceStages({
        side: 'left',
        startDate: new Date((T0 + 30 * MIN) * 1000),
        endDate: new Date((T0 + 60 * MIN) * 1000),
      })
      expect(rows.map(r => r.stage)).toEqual(['deep', 'rem'])
    })

    it('excludes segments entirely outside the window', async () => {
      const rows = await caller.getReferenceStages({
        side: 'left',
        startDate: new Date((T0 + 100 * MIN) * 1000),
        endDate: new Date((T0 + 200 * MIN) * 1000),
      })
      expect(rows).toEqual([])
    })

    it('honours limit', async () => {
      const rows = await caller.getReferenceStages({
        side: 'left',
        startDate: new Date((T0 - 60 * MIN) * 1000),
        endDate: new Date((T0 + 120 * MIN) * 1000),
        limit: 2,
      })
      expect(rows.map(r => r.stage)).toEqual(['light', 'deep'])
    })

    it('rejects startDate after endDate', async () => {
      await expect(caller.getReferenceStages({
        side: 'left',
        startDate: new Date((T0 + MIN) * 1000),
        endDate: new Date(T0 * 1000),
      })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    })
  })
})
