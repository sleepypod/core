import { inArray } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from '@/src/db/biometrics-schema'
import type { ReferenceImportInput } from './contracts'
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
