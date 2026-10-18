import { createHash, hkdfSync } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { open, readFile, stat } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { POD_CAPS } from '@/src/hardware/pods'
import { readSeed } from '@/src/homekit/storage'
import { ANALYSIS_EXPORT_FORMAT, RAW_MTIME_LAG_MS, RAW_MTIME_LEAD_MS, tarBytes, type AnalysisWindow, type WindowArchive } from './analysis-export'
import { TAR_END, tarHeader, tarPadding } from './backtest/bundle-tar'

export const ANALYSIS_DATABASE_PATH = 'biometrics.db'
export const ANALYSIS_MANIFEST_PATH = 'manifest.json'

export interface SchemaVersion { migrationHash: string, migrationCreatedAt: number, migrationTag: string | null, appliedMigrations: number }
export interface PodIdentity {
  id: string | null
  idSource: ReturnType<typeof readSeed>['source']
  hostname: string
  model: { podVersion: string, name: string, hardwareRevision: string | null } | null
}
export interface BuildInfo { branch: string, commitHash: string, commitTitle: string, buildDate: string }

export interface AnalysisBundle {
  generatedAtMs: number
  window: AnalysisWindow
  database: { path: string, bytes: number }
  archives: WindowArchive[]
  build: BuildInfo
  pod: PodIdentity
  schema: SchemaVersion | null
}

/** Latest applied drizzle migration of a biometrics database file. */
export async function readSchemaVersion(databasePath: string, journalPath = resolve(process.cwd(), 'src/db/biometrics-migrations/meta/_journal.json')): Promise<SchemaVersion | null> {
  let row: { hash: string, createdAt: number, applied: number } | undefined
  const database = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    row = database.prepare('SELECT hash, created_at AS createdAt, (SELECT COUNT(*) FROM __drizzle_migrations) AS applied FROM __drizzle_migrations ORDER BY created_at DESC, id DESC LIMIT 1')
      .get() as typeof row
  }
  catch {
    return null
  }
  finally {
    database.close()
  }
  if (!row) return null
  let migrationTag: string | null = null
  try {
    const journal = JSON.parse(await readFile(journalPath, 'utf-8')) as { entries?: Array<{ when?: unknown, tag?: unknown }> }
    const entry = journal.entries?.find(item => item.when === Number(row.createdAt))
    if (typeof entry?.tag === 'string') migrationTag = entry.tag
  }
  catch { /* tag is provenance only */ }
  return { migrationHash: row.hash, migrationCreatedAt: Number(row.createdAt), migrationTag, appliedMigrations: row.applied }
}

/** Online backup through a separate read-only connection; never writes the source. */
export async function snapshotBiometricsDatabase(sourcePath: string, directory: string) {
  const path = join(directory, ANALYSIS_DATABASE_PATH)
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
  try {
    await source.backup(path)
  }
  finally {
    source.close()
  }
  return { path, bytes: (await stat(path)).size, schema: await readSchemaVersion(path) }
}

/**
 * Same hardware-rooted seed chain as the HomeKit identity (ADR 0020), so the id
 * survives reinstalls and /persistent wipes. Derived through HKDF so the eMMC
 * CID or serial itself never leaves the pod. Null when only a random dev seed exists.
 */
export function podIdentity(): PodIdentity {
  const seed = readSeed()
  const id = seed.source === 'random-dev' ? null : Buffer.from(hkdfSync('sha256', seed.value, 'sleepypod-pod-id-v1', 'pod-id', 16)).toString('hex')
  const status = getDacMonitorIfRunning()?.getLastStatus()
  const caps = status ? POD_CAPS[status.podVersion] : undefined
  const model = status && caps
    ? { podVersion: status.podVersion, name: caps.modelName,
        hardwareRevision: status.sensorLabel.split('-').reverse().find(segment => /^[A-Z]\d{2}$/.test(segment)) ?? null }
    : null
  return { id, idSource: seed.source, hostname: hostname(), model }
}

export async function readBuildInfo(): Promise<BuildInfo> {
  const info = { branch: 'unknown', commitHash: 'unknown', commitTitle: 'unknown', buildDate: 'unknown' }
  try {
    const parsed = JSON.parse(await readFile('.git-info', 'utf-8')) as Record<string, unknown>
    for (const key of Object.keys(info) as Array<keyof BuildInfo>) {
      if (typeof parsed[key] === 'string') info[key] = parsed[key]
    }
  }
  catch { /* not built from a checkout */ }
  return info
}

const PLACEHOLDER_HASH = '0'.repeat(64)

/** manifest.json: provenance plus every other file with its size and SHA-256. */
export function analysisManifest(bundle: AnalysisBundle, hashes: { database: string, raw: readonly string[] }) {
  const { window, archives } = bundle
  const mtimes = archives.map(archive => archive.mtimeMs)
  return {
    formatVersion: ANALYSIS_EXPORT_FORMAT,
    generatedAt: new Date(bundle.generatedAtMs).toISOString(),
    generatedAtMs: bundle.generatedAtMs,
    build: bundle.build,
    pod: bundle.pod,
    schema: { biometrics: bundle.schema },
    window: {
      requested: { startMs: window.startMs, endMs: window.endMs, start: new Date(window.startMs).toISOString(), end: new Date(window.endMs).toISOString() },
      rawSelection: { includeRaw: window.includeRaw, mtimeFromMs: window.startMs - RAW_MTIME_LEAD_MS, mtimeToMs: window.endMs + RAW_MTIME_LAG_MS },
      served: { archiveCount: archives.length, rawMtimeMinMs: mtimes.length ? Math.min(...mtimes) : null, rawMtimeMaxMs: mtimes.length ? Math.max(...mtimes) : null },
    },
    files: [
      { role: 'database', path: ANALYSIS_DATABASE_PATH, bytes: bundle.database.bytes, sha256: hashes.database },
      ...archives.map((archive, index) => ({ role: 'raw', path: `raw/${archive.name}`, name: archive.name, mtimeMs: archive.mtimeMs,
        bytes: archive.bytes, sha256: hashes.raw[index] })),
    ],
    privacy: 'Contains the full biometrics database for both sides of the bed. Keep it on trusted machines.',
  }
}

// Hashes are fixed-width hex, so a placeholder manifest has the final length and
// Content-Length can be sent before the files are read.
function manifestBytes(bundle: AnalysisBundle) {
  return Buffer.byteLength(JSON.stringify(analysisManifest(bundle, { database: PLACEHOLDER_HASH, raw: bundle.archives.map(() => PLACEHOLDER_HASH) })))
}

/** Exact byte length of the tar analysisExportChunks yields. */
export function analysisBundleTarBytes(bundle: AnalysisBundle) {
  return tarBytes([bundle.database.bytes, ...bundle.archives.map(archive => archive.bytes), manifestBytes(bundle)])
}

/** Stream one file as a tar entry, hashing on the way; it must keep its listed size. */
async function* fileEntry(path: string, name: string, bytes: number, mtimeSeconds: number, digests: string[]) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size !== bytes) throw new Error(`${name} changed size before export`)
    yield tarHeader(name, bytes, mtimeSeconds)
    const digest = createHash('sha256')
    let sent = 0
    if (bytes > 0) {
      for await (const chunk of createReadStream('', { fd: handle.fd, autoClose: false, start: 0, end: bytes - 1, highWaterMark: 256 * 1024 })) {
        digest.update(chunk as Buffer)
        sent += (chunk as Buffer).length
        yield chunk as Buffer
      }
    }
    if (sent !== bytes) throw new Error(`${name} shrank during export`)
    digests.push(digest.digest('hex'))
    yield tarPadding(bytes)
  }
  finally {
    await handle.close()
  }
}

/** biometrics.db, raw/<name>.RAW.gz in mtime order, then manifest.json with the hashes taken while streaming. */
export async function* analysisExportChunks(bundle: AnalysisBundle) {
  const generatedSeconds = bundle.generatedAtMs / 1000
  const digests: string[] = []
  yield* fileEntry(bundle.database.path, ANALYSIS_DATABASE_PATH, bundle.database.bytes, generatedSeconds, digests)
  for (const archive of bundle.archives) yield* fileEntry(archive.path, `raw/${archive.name}`, archive.bytes, archive.mtimeMs / 1000, digests)
  const manifest = Buffer.from(JSON.stringify(analysisManifest(bundle, { database: digests[0], raw: digests.slice(1) })))
  if (manifest.length !== manifestBytes(bundle)) throw new Error('Manifest length changed while streaming')
  yield tarHeader(ANALYSIS_MANIFEST_PATH, manifest.length, generatedSeconds)
  yield manifest
  yield tarPadding(manifest.length)
  yield TAR_END
}
