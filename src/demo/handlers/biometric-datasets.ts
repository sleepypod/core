import { createDatasetSchema, datasetSnapshotSchema, type DatasetSnapshot } from '@/src/biometrics/backtest/contracts'
import { assignWholeNightSplits } from '@/src/biometrics/backtest/splits'
import { describeCoverage } from '@/src/biometrics/backtest/coverage'
import { demoNights, type DemoNight, type Side } from '../history'
import type { DemoHandlers, RouterOutputs } from '../types'
import { settings } from './settings'
import { dataHash, hash, uuid } from './biometric-utils'
import { demoReferenceMetrics, demoReferenceSnapshot } from './biometric-references'

type Descriptor = RouterOutputs['biometricTuning']['getDataset']
const datasets: Array<{ descriptor: Descriptor, snapshot: DatasetSnapshot | null, key: string, requestHash: string }> = []
const busy = new Set<string>()
const session = (night: DemoNight) => ({ id: night.id, side: night.side, startMs: night.enteredBedAt.getTime(), endMs: night.leftBedAt?.getTime() ?? Date.now(), sleepDurationSeconds: night.sleepDurationSeconds, timesExitedBed: night.timesExitedBed })
function selected(side: Side, id: number) {
  const night = demoNights(side).find(row => row.id === id && row.leftBedAt !== null)
  if (!night) throw new Error('NOT_FOUND: completed demo session not found for this side')
  return night
}
function get(id: string) {
  const record = datasets.find(row => row.descriptor.id === id)
  if (!record) throw new Error('NOT_FOUND: demo dataset')
  return record
}
export function demoDatasetSnapshot(id: string) {
  const record = get(id)
  if (!record.snapshot) throw new Error('DATASET_RELEASED: retained inputs unavailable')
  return structuredClone({ descriptor: record.descriptor, snapshot: record.snapshot })
}
/** Each active demo job owns a token; one completion cannot unlock another job. */
export function demoDatasetBusy(id: string, jobId: string, active: boolean) {
  const token = `${id}:${jobId}`
  if (active) busy.add(token)
  else busy.delete(token)
}
export const datasetHandlers: DemoHandlers<'biometricTuning'> = {
  // Demo data includes processed observations, never retained RAW archives or
  // qualified pod resource telemetry. Do not fabricate waveform publication.
  getReplayAdmission: () => ({ configured: false, qualificationId: null, admitted: false, reasons: ['unqualified'] }),
  listRawSources: () => ({ items: [], nextCursor: null }),
  locateRawArchives: () => [],
  inspectRawSource: input => ({ status: 'deferred', nextCursor: input.afterName }),
  createWaveformDataset: () => ({ status: 'deferred' }),
  listSessions: (input) => {
    const rows = demoNights(input.side).filter(row => row.leftBedAt !== null).map(session)
      .filter(row => input.beforeStartMs === undefined || row.startMs < input.beforeStartMs || (row.startMs === input.beforeStartMs && row.id < (input.beforeId ?? 0)))
      .sort((a, b) => b.startMs - a.startMs || b.id - a.id)
    const items = rows.slice(0, 20), last = items[items.length - 1]
    return { items, nextCursor: rows.length > 20 && last ? { startMs: last.startMs, id: last.id } : null }
  },
  getSessionCapabilities: ({ side, id }) => {
    const night = selected(side, id), window = session(night)
    return { session: window, processed: { vitals: describeCoverage(night.vitals.map(row => Math.trunc(row.t)), window.startMs, window.endMs, 120000), movement: describeCoverage(night.movement.map(row => Math.trunc(row.t)), window.startMs, window.endMs, 60000), legacyUnknownProvenanceCount: night.vitals.length },
      referenceMetrics: demoReferenceMetrics(side, window.startMs, window.endMs), comparison: night.vitals.length > 0, stageReplay: night.vitals.length > 0,
      signalReplay: false, rawWaveforms: 'not_inventoried', limitations: ['Synthetic demo nights; no raw waveforms or real processing provenance.'] }
  },
  createDataset: async (raw) => {
    if (!settings.getAll) throw new Error('Missing demo settings')
    const timezone = (await settings.getAll({})).device.timezone
    const input = createDatasetSchema.parse({ ...raw, timezone })
    if (new Set(input.sessionIds).size !== input.sessionIds.length || new Set(input.referenceImportIds).size !== input.referenceImportIds.length) throw new Error('DUPLICATE_SELECTION')
    input.sessionIds.sort((a, b) => a - b)
    input.referenceImportIds.sort()
    const requestHash = await hash(input)
    const previous = datasets.find(row => row.key === input.idempotencyKey)
    if (previous) {
      if (previous.requestHash !== requestHash) throw new Error('REVISION_CONFLICT: dataset request changed')
      return structuredClone(previous.descriptor)
    }
    const nights = input.sessionIds.map(id => selected(input.side, id)).sort((a, b) => a.enteredBedAt.getTime() - b.enteredBedAt.getTime())
    const families = new Set<string>()
    const references = input.referenceImportIds.map((id) => {
      const { descriptor, measurements } = demoReferenceSnapshot(id)
      if (descriptor.summary.side !== input.side || descriptor.summary.subjectId !== input.subjectId) throw new Error('SUBJECT_MISMATCH')
      if (families.has(descriptor.familyId)) throw new Error('REVISION_CONFLICT: select one revision per source family')
      families.add(descriptor.familyId)
      return { importId: id, revision: descriptor.revision, contentHash: descriptor.summary.contentHash, source: descriptor.summary.source, timePolicy: descriptor.summary.timePolicy, measurements: measurements.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'))) }
    })
    const snapshot = datasetSnapshotSchema.parse({ version: 'processed-dataset-v1', side: input.side, subjectId: input.subjectId, references, processingRuns: [],
      sessions: nights.map(night => ({ ...session(night), presentIntervals: night.presentIntervals, notPresentIntervals: night.notPresentIntervals,
        vitals: night.vitals.map((row, index) => ({ id: night.id * 10000 + index, timestampMs: Math.trunc(row.t), heartRate: row.heartRate, hrv: row.hrv, breathingRate: row.breathingRate, processingRunId: null })),
        movement: night.movement.map((row, index) => ({ id: night.id * 10000 + index, timestampMs: Math.trunc(row.t), totalMovement: row.score })),
      })) })
    const rows = snapshot.sessions.reduce((sum, night) => sum + night.vitals.length + night.movement.length, 0) + references.reduce((sum, ref) => sum + ref.measurements.length, 0)
    if (rows > 20000) throw new Error('RESOURCE_LIMIT: select fewer nights or references')
    const manifest: Descriptor['manifest'] = { version: 'processed-dataset-manifest-v1', splitProtocol: assignWholeNightSplits(snapshot.sessions.map(({ id, startMs, endMs }) => ({ id, startMs, endMs })), timezone),
      coverage: snapshot.sessions.map(night => ({ sessionId: night.id, vitals: describeCoverage(night.vitals.map(row => row.timestampMs), night.startMs, night.endMs, 120000), movement: describeCoverage(night.movement.map(row => row.timestampMs), night.startMs, night.endMs, 60000) })),
      capabilities: { comparison: true, stageReplay: nights.some(night => night.vitals.length > 0), signalReplay: false },
      limitations: ['Synthetic demo inputs, not measurements from a real sleeper.', 'Reference deletion does not erase these separately retained copies.', 'No raw waveforms or measured calibration are available.'] }
    const byteLength = new TextEncoder().encode(JSON.stringify(snapshot) + JSON.stringify(manifest)).byteLength
    if (byteLength > 8 * 1024 * 1024) throw new Error('RESOURCE_LIMIT: dataset exceeds 8 MiB')
    const contentHash = await dataHash({ manifest, snapshot })
    const raced = datasets.find(row => row.key === input.idempotencyKey)
    if (raced) {
      if (raced.requestHash !== requestHash) throw new Error('REVISION_CONFLICT: dataset request changed')
      return structuredClone(raced.descriptor)
    }
    if (datasets.reduce((sum, row) => sum + row.descriptor.byteLength, 0) + byteLength > 64 * 1024 * 1024) throw new Error('RESOURCE_LIMIT: demo dataset budget reached')
    const descriptor: Descriptor = { id: uuid(), side: input.side, subjectId: input.subjectId, manifest, contentHash, byteLength, createdAtMs: Date.now(), releasedAtMs: null, available: true }
    datasets.push({ descriptor, snapshot, key: input.idempotencyKey, requestHash })
    return structuredClone(descriptor)
  },
  getDataset: ({ id }) => structuredClone(get(id).descriptor),
  listDatasets: (input) => {
    const rows = datasets.map(row => row.descriptor).filter(row => row.side === input.side && (input.beforeCreatedAtMs === undefined || row.createdAtMs < input.beforeCreatedAtMs || (row.createdAtMs === input.beforeCreatedAtMs && row.id < (input.beforeId ?? '')))).sort((a, b) => b.createdAtMs - a.createdAtMs || b.id.localeCompare(a.id))
    const items = rows.slice(0, 50), last = items[items.length - 1]
    return { items: structuredClone(items), nextCursor: rows.length > 50 && last ? { createdAtMs: last.createdAtMs, id: last.id } : null }
  },
  releaseDataset: ({ id }) => {
    const record = get(id)
    if ([...busy].some(token => token.startsWith(`${id}:`))) throw new Error('INVALID_STATE: dataset has an active demo job')
    record.snapshot = null
    record.descriptor.available = false
    record.descriptor.releasedAtMs ??= Date.now()
    record.descriptor.byteLength = 0
    return structuredClone(record.descriptor)
  },
}
