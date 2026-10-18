import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/biometrics-schema'
import { REFERENCE_LIMITS, type ReferenceImportInput } from './contracts'
import { previewReferenceImport } from './normalize'
import { ReferenceStore } from './store'

type LegacyVital = typeof schema.referenceVitals.$inferSelect
type LegacyStage = typeof schema.referenceStages.$inferSelect
type LegacySample = typeof schema.referenceSamples.$inferSelect

/**
 * Called inside the existing legacy endpoint's insertion transaction. Only
 * newly accepted rows get provenance; first-write-wins and stage-overlap
 * rejection retain their old semantics. Historical unlinked rows stay unknown.
 */
export function recordLegacyReferenceImport(db: BetterSQLite3Database<typeof schema>, kind: 'vitals' | 'stages' | 'samples', rows: Array<LegacyVital | LegacyStage | LegacySample>): void {
  const first = rows[0]
  if (!first) return
  const annotation = 'Legacy Apple Watch API: explicit side mapping; sleeper identity and source timezone were not provided. Original timestamps use Unix seconds.'
  const input: ReferenceImportInput = { side: first.side, subjectId: `legacy_unknown:${first.side}`, source: first.source,
    rows: rows.map(row => 'heartRate' in row
      ? { recordKey: `apple-watch-hr:${row.timestamp.getTime()}`, metric: 'heart_rate', value: row.heartRate, unit: 'bpm', timestampMs: row.timestamp.getTime(), annotation }
      : 'metric' in row
        ? { recordKey: `apple-watch-${row.metric}:${row.timestamp.getTime()}`, metric: row.metric, value: row.value, unit: row.metric === 'breathing_rate' ? 'breaths/min' : 'ms', timestampMs: row.timestamp.getTime(), annotation }
        : { recordKey: `apple-watch-stage:${row.start.getTime()}`, metric: 'sleep_stages', value: row.stage, unit: 'stage', startMs: row.start.getTime(), endMs: row.end.getTime(), annotation }),
  }
  const preview = previewReferenceImport(input)
  const result = new ReferenceStore(db).commit({ import: input, previewHash: preview.summary.contentHash })
  const table = kind === 'vitals' ? schema.referenceVitals : kind === 'samples' ? schema.referenceSamples : schema.referenceStages
  for (let i = 0; i < rows.length; i += 100) db.update(table).set({ importId: result.id }).where(inArray(table.id, rows.slice(i, i + 100).map(row => row.id))).run()
}

/** Watch rows stored before imports carried provenance, per side. */
export function countUnlinkedLegacyReferences(db: BetterSQLite3Database<typeof schema>, side: 'left' | 'right') {
  const vitals = db.select({ n: count() }).from(schema.referenceVitals)
    .where(and(eq(schema.referenceVitals.side, side), isNull(schema.referenceVitals.importId))).get()?.n ?? 0
  const stages = db.select({ n: count() }).from(schema.referenceStages)
    .where(and(eq(schema.referenceStages.side, side), isNull(schema.referenceStages.importId))).get()?.n ?? 0
  return { vitals, stages }
}

/**
 * Give rows stored before provenance support the same import record new rows
 * get, so calibration datasets can use them. Rows go in time order, one
 * import per source and up to `REFERENCE_LIMITS.rows` rows; each batch
 * commits on its own, so an interrupted run resumes where it stopped.
 */
export function linkLegacyReferences(db: BetterSQLite3Database<typeof schema>, side: 'left' | 'right', batch: number = REFERENCE_LIMITS.rows) {
  const linked = { vitals: 0, stages: 0, imports: 0 }
  for (const kind of ['vitals', 'stages'] as const) {
    for (;;) {
      const rows = kind === 'vitals'
        ? db.select().from(schema.referenceVitals).where(and(eq(schema.referenceVitals.side, side), isNull(schema.referenceVitals.importId)))
            .orderBy(asc(schema.referenceVitals.source), asc(schema.referenceVitals.timestamp), asc(schema.referenceVitals.id)).limit(batch).all()
        : db.select().from(schema.referenceStages).where(and(eq(schema.referenceStages.side, side), isNull(schema.referenceStages.importId)))
            .orderBy(asc(schema.referenceStages.source), asc(schema.referenceStages.start), asc(schema.referenceStages.id)).limit(batch).all()
      if (rows.length === 0) break
      const source = rows[0].source
      const sameSource = (rows as Array<LegacyVital | LegacyStage>).filter(row => row.source === source)
      db.transaction(tx => recordLegacyReferenceImport(tx, kind, sameSource))
      linked[kind] += sameSource.length
      linked.imports++
    }
  }
  return linked
}
