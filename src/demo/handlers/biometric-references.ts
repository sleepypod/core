import { normalizeReferenceImport } from '@/src/biometrics/references/normalize-core'
import { REFERENCE_ADAPTER_VERSION, type ReferenceImportInput } from '@/src/biometrics/references/contracts'
import type { DemoHandlers, RouterOutputs } from '../types'
import { hash, hashText, uuid } from './biometric-utils'

type Descriptor = RouterOutputs['biometricTuning']['getImport']
type Measurement = RouterOutputs['biometricTuning']['getImportMeasurements']['items'][number]
const imports: Array<{ descriptor: Descriptor, measurements: Measurement[] }> = []
let rowId = 0
export async function previewDemoReference(input: ReferenceImportInput) {
  const result = normalizeReferenceImport(input)
  const uploadHash = await hashText(result.uploadJson)
  const measurementHashes = await Promise.all(result.measurements.map(hash))
  const contentHash = await hash({ adapterVersion: REFERENCE_ADAPTER_VERSION, uploadHash, measurementHashes, rejectionCounts: result.summary.rejectionCounts })
  return { measurements: result.measurements, summary: { ...result.summary, contentHash } }
}
function get(id: string) {
  const record = imports.find(row => row.descriptor.id === id)
  if (!record) throw new Error('NOT_FOUND: demo reference import')
  return record
}

export const referenceHandlers: DemoHandlers<'biometricTuning'> = {
  previewImport: async input => (await previewDemoReference(input)).summary,
  commitImport: async (input) => {
    const result = await previewDemoReference(input.import)
    if (result.summary.contentHash !== input.previewHash) throw new Error('STALE_PREVIEW: preview the exact import again')
    if (result.summary.rejected && !input.acceptRejectedRows) throw new Error('REJECTED_ROWS: explicitly acknowledge rejected rows')
    if (!result.measurements.length) throw new Error('NO_ACCEPTED_ROWS: no measurements to import')
    // All state checks and mutations follow awaited normalization, so concurrent
    // identical commits observe the first committed revision without duplication.
    const existing = imports.find(row => row.descriptor.available && row.descriptor.summary.contentHash === input.previewHash && row.descriptor.supersedesImportId === (input.supersedesImportId ?? null))
    if (existing) return { ...structuredClone(existing.descriptor), alreadyImported: true }
    const parent = input.supersedesImportId ? get(input.supersedesImportId).descriptor : null
    if (parent && !parent.available) throw new Error('NOT_FOUND: corrected import is unavailable')
    if (parent && (parent.summary.side !== input.import.side || parent.summary.source !== input.import.source || parent.summary.subjectId !== input.import.subjectId)) throw new Error('SUBJECT_MISMATCH: corrections must retain source, side and sleeper')
    if (parent && imports.some(row => row.descriptor.familyId === parent.familyId && row.descriptor.revision > parent.revision)) throw new Error('REVISION_CONFLICT: correct the latest revision')
    const descriptor: Descriptor = { id: uuid(), familyId: parent?.familyId ?? uuid(), revision: (parent?.revision ?? 0) + 1, supersedesImportId: parent?.id ?? null,
      summary: result.summary, createdAtMs: Date.now(), deletedAtMs: null, available: true }
    imports.push({ descriptor, measurements: result.measurements.map(row => ({ ...row, id: ++rowId })) })
    return { ...structuredClone(descriptor), alreadyImported: false }
  },
  // Demo imports always carry provenance; there are no older unlinked rows.
  countLegacyReferences: () => ({ vitals: 0, stages: 0 }),
  linkLegacyReferences: () => ({ vitals: 0, stages: 0, imports: 0 }),
  getImport: ({ id }) => structuredClone(get(id).descriptor),
  listImports: (input) => {
    const rows = imports.map(row => row.descriptor).filter(row => row.summary.side === input.side
      && (input.beforeCreatedAtMs === undefined || row.createdAtMs < input.beforeCreatedAtMs || (row.createdAtMs === input.beforeCreatedAtMs && row.id < (input.beforeId ?? ''))))
      .sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
    const items = rows.slice(0, 50), last = items[items.length - 1]
    return { items: structuredClone(items), nextCursor: rows.length > 50 && last ? { id: last.id, createdAtMs: last.createdAtMs } : null }
  },
  getImportMeasurements: ({ id, afterId = 0, limit = 500 }) => {
    if (!Number.isSafeInteger(afterId) || afterId < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('RESOURCE_LIMIT: invalid measurement page')
    const record = get(id)
    if (!record.descriptor.available) throw new Error('REFERENCE_DELETED: measurements were explicitly deleted')
    const rows = record.measurements.filter(row => row.id > afterId), items = rows.slice(0, limit)
    return { items: structuredClone(items), nextCursor: rows.length > limit ? items[items.length - 1].id : null }
  },
  deleteImport: ({ id }) => {
    const record = get(id)
    record.descriptor.deletedAtMs ??= Date.now()
    record.descriptor.available = false
    record.measurements = []
    return { id, deletedAtMs: record.descriptor.deletedAtMs }
  },
}

/** Frozen copies, independent of subsequent correction/deletion. */
export function demoReferenceSnapshot(id: string) {
  const record = get(id)
  if (!record.descriptor.available) throw new Error('REFERENCE_DELETED: reference unavailable')
  return structuredClone(record)
}
export function demoReferenceMetrics(side: 'left' | 'right', startMs: number, endMs: number) {
  const counts = new Map<string, number>()
  for (const record of imports.filter(row => row.descriptor.available && row.descriptor.summary.side === side)) {
    for (const row of record.measurements) {
      if (row.startMs < endMs && (row.endMs > startMs || (row.temporalKind === 'point' && row.startMs >= startMs))) counts.set(row.metric, (counts.get(row.metric) ?? 0) + 1)
    }
  }
  return [...counts].map(([metric, count]) => ({ metric, count }))
}
