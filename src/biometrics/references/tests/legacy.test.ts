// @vitest-environment node
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, expect, it } from 'vitest'
import * as schema from '@/src/db/biometrics-schema'
import { countUnlinkedLegacyReferences, linkLegacyReferences, recordLegacyReferenceImport } from '../legacy'
import { ReferenceStore } from '../store'

let sqlite: Database.Database
let db: ReturnType<typeof drizzle<typeof schema>>
const T = Date.UTC(2026, 9, 10, 23)
beforeEach(() => {
  sqlite = new Database(':memory:')
  db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
})
afterEach(() => sqlite.close())

it('links newly inserted legacy vitals to a normalized import with explicit unknown-sleeper provenance', () => {
  const rows = db.insert(schema.referenceVitals).values(Array.from({ length: 120 }, (_, i) => ({ side: 'left' as const, source: 'apple_watch' as const,
    timestamp: new Date(T + i * 60000), heartRate: 60 + (i % 5) }))).returning().all()
  db.transaction(tx => recordLegacyReferenceImport(tx, 'vitals', rows))
  const linked = db.select().from(schema.referenceVitals).all()
  const importIds = new Set(linked.map(row => row.importId))
  expect(importIds.size).toBe(1)
  const [importId] = importIds
  if (!importId) throw new Error('Legacy rows were not linked')
  const descriptor = new ReferenceStore(db).get(importId)
  expect(descriptor.summary).toMatchObject({ side: 'left', subjectId: 'legacy_unknown:left', source: 'apple_watch', accepted: 120, rejected: 0, metrics: ['heart_rate'] })
  const page = new ReferenceStore(db).measurements(importId)
  expect(page.items[0]).toMatchObject({ recordKey: `apple-watch-hr:${T}`, metric: 'heart_rate', value: 60, startMs: T, temporalKind: 'point' })
  expect(page.items[0].original).toMatchObject({ annotation: expect.stringContaining('Legacy Apple Watch API') })
})

it('records stage intervals and ignores empty batches', () => {
  recordLegacyReferenceImport(db, 'stages', [])
  expect(db.select().from(schema.referenceImports).all()).toEqual([])
  const rows = db.insert(schema.referenceStages).values([
    { side: 'right', source: 'apple_watch', start: new Date(T), end: new Date(T + 1800000), stage: 'light' },
    { side: 'right', source: 'apple_watch', start: new Date(T + 1800000), end: new Date(T + 3600000), stage: 'deep' },
  ]).returning().all()
  recordLegacyReferenceImport(db, 'stages', rows)
  const linked = db.select().from(schema.referenceStages).all()
  expect(linked.every(row => row.importId === linked[0].importId)).toBe(true)
  const importId = linked[0].importId
  if (!importId) throw new Error('Legacy rows were not linked')
  const page = new ReferenceStore(db).measurements(importId)
  expect(page.items.map(row => [row.stage, row.startMs, row.endMs])).toEqual([['light', T, T + 1800000], ['deep', T + 1800000, T + 3600000]])
  expect(new ReferenceStore(db).get(importId).summary).toMatchObject({ side: 'right', subjectId: 'legacy_unknown:right', accepted: 2, metrics: ['sleep_stages'] })
})

it('links rows stored before provenance support, per source and in bounded batches, and resumes', () => {
  db.insert(schema.referenceVitals).values(Array.from({ length: 5 }, (_, i) => ({ side: 'left' as const, source: 'apple_watch' as const,
    timestamp: new Date(T + i * 60000), heartRate: 60 + i }))).run()
  db.insert(schema.referenceVitals).values({ side: 'right', source: 'apple_watch', timestamp: new Date(T), heartRate: 70 }).run()
  db.insert(schema.referenceStages).values({ side: 'left', source: 'apple_watch', start: new Date(T), end: new Date(T + 1800000), stage: 'deep' }).run()
  expect(countUnlinkedLegacyReferences(db, 'left')).toEqual({ vitals: 5, stages: 1 })
  expect(linkLegacyReferences(db, 'left', 2)).toEqual({ vitals: 5, stages: 1, imports: 4 })
  expect(countUnlinkedLegacyReferences(db, 'left')).toEqual({ vitals: 0, stages: 0 })
  expect(countUnlinkedLegacyReferences(db, 'right')).toEqual({ vitals: 1, stages: 0 })
  const imports = new ReferenceStore(db).list('left').items
  expect(imports).toHaveLength(4)
  expect(imports.every(item => item.summary.subjectId === 'legacy_unknown:left')).toBe(true)
  expect(imports.map(item => item.summary.accepted).sort()).toEqual([1, 1, 2, 2])
  expect(linkLegacyReferences(db, 'left')).toEqual({ vitals: 0, stages: 0, imports: 0 })
})
