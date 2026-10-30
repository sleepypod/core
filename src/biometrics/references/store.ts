import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt, isNull, lt, max, or } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { referenceImports as imports, referenceMeasurements as measurements } from '@/src/db/biometrics-schema'
import { normalizedMeasurementSchema, previewSummarySchema, referenceImportSchema } from './contracts'
import { previewReferenceImport } from './normalize'
import { ReferenceInputError } from './time'

export const commitReferenceSchema = z.object({
  import: referenceImportSchema,
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  acceptRejectedRows: z.boolean().default(false),
  supersedesImportId: z.string().uuid().optional(),
}).strict()

type BioDB = BetterSQLite3Database<typeof schema>
type ImportRecord = typeof imports.$inferSelect

function describeImport(row: ImportRecord) {
  return { id: row.id, familyId: row.familyId, revision: row.revision,
    supersedesImportId: row.supersedesImportId, summary: previewSummarySchema.parse(row.summary),
    createdAtMs: row.createdAtMs, deletedAtMs: row.deletedAtMs, available: row.deletedAtMs === null }
}

/** Immutable normalized records. Corrections never update an earlier revision. */
export class ReferenceStore {
  constructor(private readonly db: BioDB, private readonly now = Date.now) {}

  commit(raw: z.input<typeof commitReferenceSchema>) {
    const input = commitReferenceSchema.parse(raw)
    const preview = previewReferenceImport(input.import)
    if (preview.summary.contentHash !== input.previewHash) throw new ReferenceInputError('STALE_PREVIEW', 'Import bytes or interpretation changed; preview the exact import again')
    if (preview.summary.rejected && !input.acceptRejectedRows) throw new ReferenceInputError('REJECTED_ROWS', 'Resolve rejected rows or explicitly accept a partial import')
    if (!preview.measurements.length) throw new ReferenceInputError('NO_ACCEPTED_ROWS', 'There are no accepted measurements to import')
    return this.db.transaction((tx) => {
      const existing = tx.select().from(imports).where(and(eq(imports.contentHash, input.previewHash),
        input.supersedesImportId ? eq(imports.supersedesImportId, input.supersedesImportId) : isNull(imports.supersedesImportId),
        isNull(imports.deletedAtMs))).get()
      if (existing) return { ...describeImport(existing), alreadyImported: true }
      const parent = input.supersedesImportId ? tx.select().from(imports).where(eq(imports.id, input.supersedesImportId)).get() : undefined
      if (input.supersedesImportId && (!parent || parent.deletedAtMs !== null)) throw new ReferenceInputError('NOT_FOUND', 'The import being corrected is unavailable')
      if (parent && (parent.side !== input.import.side || parent.source !== input.import.source || parent.subjectId !== input.import.subjectId)) throw new ReferenceInputError('SUBJECT_MISMATCH', 'A corrected export must retain its source, side and sleeper mapping')
      let revision = 1
      if (parent) {
        const family = eq(imports.familyId, parent.familyId)
        const latest = tx.select().from(imports).where(and(family, isNull(imports.deletedAtMs))).orderBy(desc(imports.revision)).get()
        if (latest?.id !== parent.id) throw new ReferenceInputError('REVISION_CONFLICT', 'Another correction exists; use the latest import revision')
        // Deleted revisions still own their number under uq_reference_import_revision.
        revision = (tx.select({ revision: max(imports.revision) }).from(imports).where(family).get()?.revision ?? parent.revision) + 1
      }
      const id = randomUUID()
      const row = tx.insert(imports).values({ id, familyId: parent?.familyId ?? randomUUID(), revision,
        supersedesImportId: parent?.id ?? null, contentHash: input.previewHash, source: input.import.source,
        adapterVersion: preview.summary.adapterVersion, side: input.import.side, subjectId: input.import.subjectId,
        timePolicy: preview.summary.timePolicy, summary: preview.summary, overlapPolicy: 'exclude_conflicts',
        acceptedCount: preview.summary.accepted, rejectedCount: preview.summary.rejected, createdAtMs: this.now(),
      }).returning().get()
      // SQLite parameter counts and write durations remain bounded per batch.
      for (let i = 0; i < preview.measurements.length; i += 40) {
        tx.insert(measurements).values(preview.measurements.slice(i, i + 40).map(measurement => ({ ...measurement, importId: id, side: input.import.side }))).run()
      }
      return { ...describeImport(row), alreadyImported: false }
    }, { behavior: 'immediate' })
  }

  get(id: string) {
    const row = this.db.select().from(imports).where(eq(imports.id, id)).get()
    if (!row) throw new ReferenceInputError('NOT_FOUND', 'Reference import not found')
    return describeImport(row)
  }

  list(side: 'left' | 'right', cursor?: { createdAtMs: number, id: string }) {
    const rows = this.db.select().from(imports).where(and(eq(imports.side, side),
      cursor ? or(lt(imports.createdAtMs, cursor.createdAtMs), and(eq(imports.createdAtMs, cursor.createdAtMs), lt(imports.id, cursor.id))) : undefined,
    )).orderBy(desc(imports.createdAtMs), desc(imports.id)).limit(51).all()
    const items = rows.slice(0, 50).map(describeImport)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > 50 && last ? { createdAtMs: last.createdAtMs, id: last.id } : null }
  }

  measurements(id: string, afterId = 0, limit = 500) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500 || !Number.isSafeInteger(afterId) || afterId < 0) throw new ReferenceInputError('RESOURCE_LIMIT', 'Use a nonnegative row cursor and a page size from 1 to 500')
    if (!this.get(id).available) throw new ReferenceInputError('REFERENCE_DELETED', 'Reference measurements were explicitly deleted')
    const rows = this.db.select().from(measurements).where(and(eq(measurements.importId, id), gt(measurements.id, afterId))).orderBy(measurements.id).limit(limit + 1).all()
    const items = rows.slice(0, limit).map(row => ({ id: row.id, ...normalizedMeasurementSchema.parse({
      recordKey: row.recordKey, metric: row.metric, value: row.value, stage: row.stage, unit: row.unit,
      startMs: row.startMs, endMs: row.endMs, temporalKind: row.temporalKind, aggregation: row.aggregation,
      windowMs: row.windowMs, quality: row.quality, scorable: row.scorable, exclusions: row.exclusions, original: row.original,
    }) }))
    return { items, nextCursor: rows.length > limit ? items.at(-1)?.id ?? null : null }
  }

  /** Frozen datasets own their copies; deleting an import cannot mutate them. */
  delete(id: string) {
    return this.db.transaction((tx) => {
      const importRecord = this.get(id)
      if (!importRecord.available) return { id, deletedAtMs: importRecord.deletedAtMs }
      tx.delete(measurements).where(eq(measurements.importId, id)).run()
      tx.delete(schema.referenceStages).where(eq(schema.referenceStages.importId, id)).run()
      tx.delete(schema.referenceVitals).where(eq(schema.referenceVitals.importId, id)).run()
      tx.delete(schema.referenceSamples).where(eq(schema.referenceSamples.importId, id)).run()
      const deletedAtMs = this.now()
      tx.update(imports).set({ deletedAtMs }).where(eq(imports.id, id)).run()
      return { id, deletedAtMs }
    }, { behavior: 'immediate' })
  }
}
