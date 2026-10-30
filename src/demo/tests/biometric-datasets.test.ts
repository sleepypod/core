// @vitest-environment node
import { expect, it } from 'vitest'
import { datasetHandlers as handlers, demoDatasetSnapshot, demoDatasetBusy } from '../handlers/biometric-datasets'
import { referenceHandlers } from '../handlers/biometric-references'
import { datasetDescriptorSchema } from '@/src/biometrics/backtest/contracts'
import { dataHash } from '@/src/biometrics/algorithms/canonical'
function required<T>(handler: T | undefined): T {
  if (!handler) throw new Error('Missing demo handler')
  return handler
}
it('pages eligible synthetic nights and freezes exact retained inputs with whole-night splits', async () => {
  const first = await required(handlers.listSessions)({ side: 'left' })
  expect(first.items).toHaveLength(20)
  expect(first.nextCursor).not.toBeNull()
  const second = await required(handlers.listSessions)({ side: 'left', beforeId: first.nextCursor?.id, beforeStartMs: first.nextCursor?.startMs })
  expect(new Set([...first.items, ...second.items].map(row => row.id)).size).toBe(first.items.length + second.items.length)
  const capability = await required(handlers.getSessionCapabilities)({ side: 'left', id: first.items[0].id })
  expect(capability.stageReplay).toBe(true)
  expect(capability.signalReplay).toBe(false)
  expect(capability.processed.vitals.expectedCadenceMs).toBe(120000)
  const request = { side: 'left' as const, subjectId: 'demo-sleeper', sessionIds: first.items.slice(0, 3).map(row => row.id), referenceImportIds: [], idempotencyKey: 'frozen-demo-test' }
  const results = await Promise.all([0, 1].map(() => required(handlers.createDataset)(request)))
  const descriptor = datasetDescriptorSchema.parse(results[0])
  expect(results[1]).toEqual(descriptor)
  expect(descriptor.manifest.splitProtocol.assignments.map(row => row.split)).toEqual(['tuning', 'validation', 'holdout'])
  const captured = demoDatasetSnapshot(descriptor.id)
  expect(descriptor.contentHash).toBe(dataHash({ manifest: descriptor.manifest, snapshot: captured.snapshot }))
  captured.snapshot.sessions[0].vitals.length = 0
  expect(demoDatasetSnapshot(descriptor.id).snapshot.sessions[0].vitals.length).toBeGreaterThan(0)
  await expect(required(handlers.createDataset)({ ...request, subjectId: 'changed' })).rejects.toThrow('REVISION_CONFLICT')
  await expect(required(handlers.createDataset)({ ...request, side: 'right', idempotencyKey: 'wrong-side-demo' })).rejects.toThrow('NOT_FOUND')
})
it('retains reference copies after deletion and honors every active job before release', async () => {
  const sessions = await required(handlers.listSessions)({ side: 'right' })
  const batch = { side: 'right' as const, subjectId: 'demo-sleeper', source: 'dataset-test', rows: [{ recordKey: 'hr', metric: 'heart_rate', timestampMs: sessions.items[0].startMs, value: 60, unit: 'bpm' }] }
  const preview = await required(referenceHandlers.previewImport)(batch)
  const reference = await required(referenceHandlers.commitImport)({ import: batch, previewHash: preview.contentHash })
  const dataset = await required(handlers.createDataset)({ side: 'right', subjectId: 'demo-sleeper', sessionIds: [sessions.items[0].id], referenceImportIds: [reference.id], idempotencyKey: 'reference-copy-demo' })
  await required(referenceHandlers.deleteImport)({ id: reference.id })
  expect(demoDatasetSnapshot(dataset.id).snapshot.references[0].measurements[0].value).toBe(60)
  demoDatasetBusy(dataset.id, 'one', true)
  demoDatasetBusy(dataset.id, 'two', true)
  demoDatasetBusy(dataset.id, 'one', false)
  expect(() => required(handlers.releaseDataset)({ id: dataset.id })).toThrow('active demo job')
  demoDatasetBusy(dataset.id, 'two', false)
  const released = await required(handlers.releaseDataset)({ id: dataset.id })
  expect(released).toMatchObject({ available: false, byteLength: 0, contentHash: dataset.contentHash })
  expect(() => demoDatasetSnapshot(dataset.id)).toThrow('DATASET_RELEASED')
  expect(await required(handlers.releaseDataset)({ id: dataset.id })).toEqual(released)
})

it('rejects duplicate, mismatched and oversized selections and pages dataset descriptors', async () => {
  const unknown = '00000000-0000-4000-8000-000000000000'
  expect(() => required(handlers.getDataset)({ id: unknown })).toThrow('NOT_FOUND: demo dataset')
  const sessions = await required(handlers.listSessions)({ side: 'left' })
  expect((await required(handlers.listSessions)({ side: 'left', beforeStartMs: sessions.items[0].startMs })).items.slice(0, 19)).toEqual(sessions.items.slice(1))
  expect(await required(handlers.listSessions)({ side: 'left', beforeStartMs: 0 })).toEqual({ items: [], nextCursor: null })
  const base = { side: 'left' as const, subjectId: 'demo-sleeper', referenceImportIds: [] as string[] }
  await expect(required(handlers.createDataset)({ ...base, sessionIds: [sessions.items[0].id, sessions.items[0].id], idempotencyKey: 'duplicate-sessions' })).rejects.toThrow('DUPLICATE_SELECTION')
  const batch = { side: 'left' as const, subjectId: 'other-sleeper', source: 'dataset-test', rows: [{ recordKey: 'hr', metric: 'heart_rate', timestampMs: sessions.items[0].startMs, value: 60, unit: 'bpm' }] }
  const preview = await required(referenceHandlers.previewImport)(batch)
  const reference = await required(referenceHandlers.commitImport)({ import: batch, previewHash: preview.contentHash })
  await expect(required(handlers.createDataset)({ ...base, sessionIds: [sessions.items[0].id], referenceImportIds: [reference.id], idempotencyKey: 'mismatch' })).rejects.toThrow('SUBJECT_MISMATCH')
  const mine = { ...batch, subjectId: 'demo-sleeper' }
  const first = await required(referenceHandlers.commitImport)({ import: mine, previewHash: (await required(referenceHandlers.previewImport)(mine)).contentHash })
  const corrected = { ...mine, rows: [{ ...mine.rows[0], value: 61 }] }
  const second = await required(referenceHandlers.commitImport)({ import: corrected, previewHash: (await required(referenceHandlers.previewImport)(corrected)).contentHash, supersedesImportId: first.id })
  await expect(required(handlers.createDataset)({ ...base, sessionIds: [sessions.items[0].id], referenceImportIds: [first.id, second.id], idempotencyKey: 'family' })).rejects.toThrow('one revision per source family')
  const capability = await required(handlers.getSessionCapabilities)({ side: 'left', id: sessions.items[0].id })
  expect(capability.referenceMetrics).toEqual([{ metric: 'heart_rate', count: 3 }])
  const request = { ...base, sessionIds: [sessions.items[1].id], idempotencyKey: 'sequential-retry' }
  const created = await required(handlers.createDataset)(request)
  expect(await required(handlers.createDataset)(request)).toEqual(created)
  expect(await required(handlers.getDataset)({ id: created.id })).toEqual(created)
  const beforeRace = await required(handlers.listDatasets)({ side: 'left' })
  const raceRequests = [{ ...request, idempotencyKey: 'raced' }, { ...request, idempotencyKey: 'raced', subjectId: 'raced-sleeper' }]
  const raced = await Promise.allSettled(raceRequests.map(input => required(handlers.createDataset)(input)))
  // WebCrypto may finish either request first; the stored winner must be unique.
  expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(raced.filter(result => result.status === 'rejected')).toHaveLength(1)
  for (const [index, result] of raced.entries()) {
    if (result.status === 'fulfilled') {
      expect(result.value.subjectId).toBe(raceRequests[index].subjectId)
      expect(await required(handlers.createDataset)(raceRequests[index])).toEqual(result.value)
      expect(await required(handlers.getDataset)({ id: result.value.id })).toEqual(result.value)
    }
    else {
      expect(result.reason).toMatchObject({ message: expect.stringContaining('REVISION_CONFLICT') })
      await expect(required(handlers.createDataset)(raceRequests[index])).rejects.toThrow('REVISION_CONFLICT')
    }
  }
  const page = await required(handlers.listDatasets)({ side: 'left' })
  expect(page.items).toHaveLength(beforeRace.items.length + 1)
  expect(page.items.map(row => row.id)).toContain(created.id)
  expect(page.nextCursor).toBeNull()
  const newest = page.items[0]
  expect((await required(handlers.listDatasets)({ side: 'left', beforeCreatedAtMs: newest.createdAtMs, beforeId: newest.id })).items.map(row => row.id)).not.toContain(newest.id)
  expect((await required(handlers.listDatasets)({ side: 'left', beforeCreatedAtMs: 0 })).items).toEqual([])
  const all = [...sessions.items, ...(await required(handlers.listSessions)({ side: 'left', beforeId: sessions.nextCursor?.id, beforeStartMs: sessions.nextCursor?.startMs })).items]
  await expect(required(handlers.createDataset)({ ...base, sessionIds: all.map(row => row.id), idempotencyKey: 'too-many-rows' })).rejects.toThrow('RESOURCE_LIMIT')
})

it('does not invent raw archives or resource qualification for demo waveform controls', async () => {
  expect(await required(handlers.getReplayAdmission)({})).toEqual({ configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] })
  expect(await required(handlers.listRawSources)({ startMs: 0, endMs: 1000 })).toEqual({ items: [], nextCursor: null })
  expect(await required(handlers.inspectRawSource)({ afterName: 'a.RAW.gz' })).toEqual({ status: 'deferred', nextCursor: 'a.RAW.gz' })
  expect(await required(handlers.createWaveformDataset)({ parentDatasetId: '00000000-0000-4000-8000-000000000001', expectedContentHash: 'a'.repeat(64),
    cohorts: [{ cohortId: 'night', sourceIds: ['b'.repeat(64)] }], idempotencyKey: 'demo-raw' })).toEqual({ status: 'deferred' })
})
