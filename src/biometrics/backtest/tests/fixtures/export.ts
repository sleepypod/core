import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from '@/src/db/biometrics-schema'
import { dataHash } from '../../../algorithms/canonical'
import { previewReferenceImport } from '../../../references/normalize'
import { datasetManifestSchema, datasetSnapshotSchema } from '../../contracts'

export const exportStartMs = 1791673200000
const DAY = 86400000, NIGHT = 600000
export const exportNights = [
  { cohortId: 'night-a', split: 'tuning' as const, startMs: exportStartMs },
  { cohortId: 'night-b', split: 'validation' as const, startMs: exportStartMs + DAY },
  { cohortId: 'night-c', split: 'holdout' as const, startMs: exportStartMs + 2 * DAY },
]

/** A complete retained waveform dataset in a file-backed biometrics database:
 * one gzip archive per night in DIRECTORY/biometric-raw, plus one unreferenced
 * archive that an export must leave out. */
export function exportableWaveformDataset(directory: string) {
  const sqlite = new Database(join(directory, 'biometrics.db'))
  sqlite.pragma('foreign_keys = ON')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: 'src/db/biometrics-migrations' })
  const rawDirectory = join(directory, 'biometric-raw')
  mkdirSync(rawDirectory, { mode: 0o700 })
  const archive = (text: string) => {
    const expanded = Buffer.from(text)
    const bytes = gzipSync(expanded)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    writeFileSync(join(rawDirectory, `${sha256}.RAW.gz`), bytes, { mode: 0o600 })
    return { name: `${sha256}.RAW.gz`, sha256, compressed_bytes: bytes.length, expanded_bytes: expanded.length }
  }
  const artifacts = exportNights.map(night => archive(`fixture waveform ${night.cohortId}`))
  const unrelated = archive('another dataset')
  const sessions = exportNights.map((night, index) => ({ id: index + 1, startMs: night.startMs, endMs: night.startMs + NIGHT, sleepDurationSeconds: 600,
    timesExitedBed: 0, presentIntervals: null, notPresentIntervals: null, movement: [],
    vitals: Array.from({ length: 10 }, (_, id) => ({ id: index * 100 + id, timestampMs: night.startMs + id * 60000, heartRate: 60, hrv: 30, breathingRate: 14, processingRunId: null })) }))
  const measurements = previewReferenceImport({ side: 'left', subjectId: 'A', source: 'fixture', rows: exportNights.flatMap(night =>
    Array.from({ length: 5 }, (_, index) => ({ recordKey: `${night.cohortId}-hr-${index}`, metric: 'heart_rate' as const, value: 62, unit: 'bpm', timestampMs: night.startMs + index * 120000 }))) }).measurements
  const snapshot = datasetSnapshotSchema.parse({ version: 'waveform-dataset-v1', side: 'left', subjectId: 'A', sessions, processingRuns: [],
    references: [{ importId: 'ref', revision: 1, contentHash: 'fixture', source: 'fixture', timePolicy: {}, measurements }],
    waveformInputs: exportNights.map((night, index) => ({ cohortId: night.cohortId, input: { version: 'retained-waveform-input-v1',
      retained_start_ms: night.startMs, score_start_ms: night.startMs, score_end_ms: night.startMs + NIGHT,
      artifacts: [{ artifact: artifacts[index], first_event_ms: night.startMs, last_event_ms: night.startMs + NIGHT - 1 }], contexts: [] } })) })
  const manifest = datasetManifestSchema.parse({ version: 'waveform-dataset-manifest-v1',
    splitProtocol: { version: 'chronological-whole-night-v1', timezone: 'UTC', timezoneRuntime: { icu: 'fixture', tz: 'fixture' }, grouping: 'local_noon_connected_sessions',
      assignments: exportNights.map((night, index) => ({ cohortId: night.cohortId, nightLabels: [night.cohortId], sessionIds: [index + 1], startMs: night.startMs, endMs: night.startMs + NIGHT, split: night.split })),
      evidence: 'partitioned_not_validated', limitations: [] },
    coverage: [], capabilities: { comparison: true, stageReplay: true, signalReplay: true }, limitations: [] })
  const id = randomUUID()
  const contentHash = dataHash({ manifest, snapshot })
  db.insert(schema.biometricDatasets).values({ id, side: 'left', subjectId: 'A', idempotencyKey: id, requestHash: id, contentHash,
    manifest, snapshot, byteLength: Buffer.byteLength(JSON.stringify({ manifest, snapshot })), createdAtMs: exportStartMs }).run()
  for (const artifact of [...artifacts, unrelated]) db.insert(schema.biometricRawArtifacts).values({ contentHash: artifact.sha256, name: artifact.name,
    compressedBytes: artifact.compressed_bytes, expandedBytes: artifact.expanded_bytes, createdAtMs: exportStartMs }).run()
  artifacts.forEach((artifact, position) => db.insert(schema.biometricDatasetRawArtifacts).values({ id: randomUUID(), datasetId: id, artifactHash: artifact.sha256, position }).run())
  return { sqlite, db, id, rawDirectory, artifacts, unrelated, manifest, snapshot, contentHash }
}
