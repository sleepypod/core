import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { z } from 'zod'
import * as schema from '@/src/db/biometrics-schema'
import { ReferenceInputError } from '../references/time'
import { TAR_END, tarHeader, tarPadding } from './bundle-tar'
import { DatasetStore } from './datasets'

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const size = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const rawBundlePathSchema = z.string().regex(/^raw\/[a-f0-9]{64}\.RAW\.gz$/)
export const datasetBundleFileSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('manifest'), path: z.literal('manifest.json'), sha256: hash, bytes: size }).strict(),
  z.object({ role: z.literal('snapshot'), path: z.literal('snapshot.json'), sha256: hash, bytes: size }).strict(),
  z.object({ role: z.literal('raw'), path: rawBundlePathSchema, sha256: hash, bytes: size, expandedBytes: size }).strict()
    .refine(file => file.path === `raw/${file.sha256}.RAW.gz`, 'Raw bundle path must name its content hash'),
])
/** The bundle's own table of contents. Every other file is listed with its exact
 * bytes and SHA-256; a reader must reject anything unlisted. */
export const datasetBundleIndexSchema = z.object({
  version: z.literal('calibration-dataset-bundle-v1'),
  dataset: z.object({ id: z.string().uuid(), side: z.enum(['left', 'right']), subjectId: z.string(), contentHash: hash,
    snapshotVersion: z.enum(['processed-dataset-v1', 'waveform-dataset-v1']), createdAtMs: size }).strict(),
  files: z.array(datasetBundleFileSchema).min(2).max(1026),
  limitations: z.array(z.string().max(500)).max(10),
}).strict()
export type DatasetBundleIndex = z.infer<typeof datasetBundleIndexSchema>

export const DATASET_BUNDLE_INDEX_PATH = 'bundle.json'
const LIMITATIONS = [
  'Contains only this frozen dataset: its manifest, snapshot and the retained RAW archives it references.',
  'Off-pod replay of this bundle is exploratory; only a backtest on the pod can serve as activation evidence.',
  'Dual-channel RAW archives include the other side of the bed.',
]

export function retainedRawDirectory(db: BetterSQLite3Database<typeof schema>) {
  const path = db.all<{ name: string, file: string }>(sql`PRAGMA database_list`).find(row => row.name === 'main')?.file
  if (!path) throw new ReferenceInputError('WORKER_UNAVAILABLE', 'Dataset export requires a persistent biometrics database')
  return join(dirname(path), 'biometric-raw')
}

/** Open a retained artifact without following links; size must match its record. */
export async function openRetainedArtifact(directory: string, name: string, expectedBytes: number) {
  if (!/^[a-f0-9]{64}\.RAW\.gz$/.test(name)) throw new ReferenceInputError('DATASET_CORRUPT', 'Invalid retained artifact name')
  const handle = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ReferenceInputError('DATASET_CORRUPT', 'A retained RAW archive is missing')
  })
  const info = await handle.stat()
  if (!info.isFile() || info.size !== expectedBytes) {
    await handle.close()
    throw new ReferenceInputError('DATASET_CORRUPT', 'A retained RAW archive changed size')
  }
  return handle
}

async function hashRetainedArtifact(directory: string, name: string, expectedBytes: number) {
  const handle = await openRetainedArtifact(directory, name, expectedBytes)
  try {
    const digest = createHash('sha256')
    for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false, highWaterMark: 1024 * 1024 })) digest.update(chunk as Buffer)
    return digest.digest('hex')
  }
  finally {
    await handle.close()
  }
}

/** Verify a live dataset and every retained archive it references before anything
 * is streamed. Released or missing datasets surface as NOT_FOUND/DATASET_RELEASED. */
export async function prepareDatasetExport(db: BetterSQLite3Database<typeof schema>, id: string, retainedDirectory = retainedRawDirectory(db)) {
  const dataset = new DatasetStore(db).read(id)
  const references = db.select({ position: schema.biometricDatasetRawArtifacts.position, hash: schema.biometricRawArtifacts.contentHash,
    name: schema.biometricRawArtifacts.name, compressedBytes: schema.biometricRawArtifacts.compressedBytes, expandedBytes: schema.biometricRawArtifacts.expandedBytes })
    .from(schema.biometricDatasetRawArtifacts)
    .innerJoin(schema.biometricRawArtifacts, eq(schema.biometricRawArtifacts.contentHash, schema.biometricDatasetRawArtifacts.artifactHash))
    .where(and(eq(schema.biometricDatasetRawArtifacts.datasetId, id), isNull(schema.biometricDatasetRawArtifacts.releasedAtMs)))
    .orderBy(asc(schema.biometricDatasetRawArtifacts.position)).all()
  const frozen = new Map(dataset.snapshot.version === 'waveform-dataset-v1'
    ? dataset.snapshot.waveformInputs.flatMap(cohort => cohort.input.artifacts.map(source => [source.artifact.sha256, source.artifact] as const))
    : [])
  if (references.length !== frozen.size || references.some((row) => {
    const artifact = frozen.get(row.hash)
    return !artifact || row.name !== artifact.name || row.compressedBytes !== artifact.compressed_bytes || row.expandedBytes !== artifact.expanded_bytes
  })) throw new ReferenceInputError('DATASET_CORRUPT', 'Retained RAW references do not match the frozen dataset')
  const raw = []
  for (const row of references) {
    if (await hashRetainedArtifact(retainedDirectory, row.name, row.compressedBytes) !== row.hash) {
      throw new ReferenceInputError('DATASET_CORRUPT', 'A retained RAW archive failed its SHA-256 check')
    }
    raw.push({ role: 'raw' as const, path: `raw/${row.name}`, sha256: row.hash, bytes: row.compressedBytes, expandedBytes: row.expandedBytes })
  }
  const manifestText = JSON.stringify(dataset.manifest)
  const snapshotText = JSON.stringify(dataset.snapshot)
  const text = (role: 'manifest' | 'snapshot', path: 'manifest.json' | 'snapshot.json', value: string) => ({ role, path,
    sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value) })
  const index = datasetBundleIndexSchema.parse({ version: 'calibration-dataset-bundle-v1',
    dataset: { id: dataset.id, side: dataset.side, subjectId: dataset.subjectId, contentHash: dataset.contentHash,
      snapshotVersion: dataset.snapshot.version, createdAtMs: dataset.createdAtMs },
    files: [text('manifest', 'manifest.json', manifestText), text('snapshot', 'snapshot.json', snapshotText), ...raw],
    limitations: LIMITATIONS })
  return { index, manifestText, snapshotText }
}

/** Exact byte length of the uncompressed tar stream the export route writes. */
export function datasetBundleTarBytes(index: DatasetBundleIndex) {
  const indexBytes = Buffer.byteLength(JSON.stringify(index))
  return [indexBytes, ...index.files.map(file => file.bytes)].reduce((sum, bytes) => sum + 512 + Math.ceil(bytes / 512) * 512, 1024)
}

/** Tar chunks for one prepared export, in index order. */
export async function* datasetBundleChunks(index: DatasetBundleIndex, texts: { manifest: string, snapshot: string }, directory: string) {
  const mtime = index.dataset.createdAtMs / 1000
  const indexText = Buffer.from(JSON.stringify(index))
  yield tarHeader(DATASET_BUNDLE_INDEX_PATH, indexText.length, mtime)
  yield indexText
  yield tarPadding(indexText.length)
  for (const file of index.files) {
    if (file.role !== 'raw') {
      const body = Buffer.from(file.role === 'manifest' ? texts.manifest : texts.snapshot)
      yield tarHeader(file.path, body.length, mtime)
      yield body
      yield tarPadding(body.length)
      continue
    }
    // Hash again while streaming: verification ran in the coordinator, and the
    // bytes sent must be the bytes verified. A mismatch aborts the download.
    const handle = await openRetainedArtifact(directory, `${file.sha256}.RAW.gz`, file.bytes)
    try {
      yield tarHeader(file.path, file.bytes, mtime)
      const digest = createHash('sha256')
      let sent = 0
      for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false, highWaterMark: 256 * 1024 })) {
        const bytes = chunk as Buffer
        digest.update(bytes)
        sent += bytes.length
        if (sent > file.bytes) throw new Error('Retained archive grew during export')
        yield bytes
      }
      if (sent !== file.bytes || digest.digest('hex') !== file.sha256) throw new Error('Retained archive changed during export')
      yield tarPadding(file.bytes)
    }
    finally {
      await handle.close()
    }
  }
  yield TAR_END
}
