import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * What's using /persistent and what sp-storage-cleanup can reclaim, for the
 * System → Storage page. The biometrics pruner deletes the oldest RAW archives
 * to keep /persistent under PRUNER_TARGET_PERCENT, so everything else on the
 * partition directly shortens raw history.
 */

export const PERSISTENT_ROOT = '/persistent'
export const PRUNER_TARGET_PERCENT = Number(process.env.SP_PRUNER_TARGET_PCT) || 80
const ARCHIVE_DIR = `${PERSISTENT_ROOT}/biometrics-archive`
const SWAPFILE = `${PERSISTENT_ROOT}/swapfile`
const INSTALL_DIR = process.env.SP_INSTALL_DIR ?? '/home/dac/sleepypod-core'
const CLEANUP_BIN = '/usr/local/bin/sp-storage-cleanup'
const LIVE_DB_FILES = ['sleepypod.db', 'sleepypod.db-wal', 'sleepypod.db-shm', 'biometrics.db', 'biometrics.db-wal', 'biometrics.db-shm']

export type SegmentKey = 'rawArchive' | 'app' | 'database' | 'swap' | 'reclaimable' | 'other'
export type ReclaimKind = 'temp' | 'release' | 'modules' | 'backup'

export interface ReclaimItem {
  path: string
  bytes: number
  reason: string
  kind: ReclaimKind
}

export interface StorageReport {
  persistent: { totalBytes: number, usedBytes: number, availableBytes: number, usedPercent: number }
  prunerTargetPercent: number
  segments: Array<{ key: SegmentKey, bytes: number }>
  rawHistory: { fileCount: number, oldest: string | null, newest: string | null, days: number | null }
  reclaimable: { available: boolean, items: ReclaimItem[], totalBytes: number }
}

async function dataDir(): Promise<string> {
  try {
    return (await readFile('/etc/sleepypod/data-dir', 'utf-8')).trim() || `${PERSISTENT_ROOT}/sleepypod-data`
  }
  catch {
    return `${PERSISTENT_ROOT}/sleepypod-data`
  }
}

/** `df -P` in 1K blocks — POSIX, so it parses the same on busybox and GNU. */
export async function dfPosix(path: string): Promise<StorageReport['persistent'] | null> {
  try {
    const { stdout } = await execFileAsync('df', ['-P', '-k', path], { timeout: 5000 })
    const parts = stdout.trim().split('\n')[1]?.trim().split(/\s+/) ?? []
    const totalBytes = (Number(parts[1]) || 0) * 1024
    const usedBytes = (Number(parts[2]) || 0) * 1024
    const availableBytes = (Number(parts[3]) || 0) * 1024
    const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
    return { totalBytes, usedBytes, availableBytes, usedPercent }
  }
  catch {
    return null
  }
}

/**
 * Sizes for several paths from one `du -sk` call. du counts a hardlinked
 * inode only once across its arguments, so the sizes don't double-count
 * pnpm's shared files between releases. Missing paths are skipped.
 */
export async function duMany(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (paths.length === 0) return out
  let stdout = ''
  try {
    ({ stdout } = await execFileAsync('du', ['-sk', '--', ...paths], { timeout: 30_000 }))
  }
  catch (err) {
    // du exits non-zero when some path is missing but still prints the rest.
    stdout = (err as { stdout?: string }).stdout ?? ''
  }
  for (const line of stdout.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.+)$/)
    if (m) out.set(m[2], Number(m[1]) * 1024)
  }
  return out
}

function kindOf(path: string): ReclaimKind {
  if (path.includes('/sleepypod-releases/')) return 'release'
  if (path.endsWith('/node_modules')) return 'modules'
  if (/\.db[.-]/.test(path)) return 'backup'
  return 'temp'
}

function cleanupAvailable(): boolean {
  try {
    accessSync(CLEANUP_BIN, constants.X_OK)
    return true
  }
  catch {
    return false
  }
}

function parseCleanup(stdout: string): { items: ReclaimItem[], freedBytes: number } {
  const parsed = JSON.parse(stdout) as { items?: Array<{ path: unknown, bytes: unknown, reason: unknown }>, freedBytes?: unknown }
  const items = (parsed.items ?? [])
    .filter(i => typeof i.path === 'string')
    .map(i => ({
      path: i.path as string,
      bytes: Number(i.bytes) || 0,
      reason: typeof i.reason === 'string' ? i.reason : '',
      kind: kindOf(i.path as string),
    }))
  return { items, freedBytes: Number(parsed.freedBytes) || 0 }
}

/** Dry-run plan from sp-storage-cleanup, database backups included so the page can offer them. */
async function reclaimPlan(): Promise<StorageReport['reclaimable']> {
  if (!cleanupAvailable()) return { available: false, items: [], totalBytes: 0 }
  try {
    const { stdout } = await execFileAsync(CLEANUP_BIN, ['--dry-run', '--json', '--include-db-backups'], { timeout: 60_000 })
    const { items, freedBytes } = parseCleanup(stdout)
    return { available: true, items, totalBytes: freedBytes }
  }
  catch {
    return { available: false, items: [], totalBytes: 0 }
  }
}

async function rawHistory(): Promise<StorageReport['rawHistory']> {
  try {
    const names = (await readdir(ARCHIVE_DIR)).filter(n => n.endsWith('.gz'))
    const mtimes = (await Promise.all(names.map(n => stat(join(ARCHIVE_DIR, n)).then(s => s.mtimeMs, () => null))))
      .filter((m): m is number => m != null)
    if (mtimes.length === 0) return { fileCount: 0, oldest: null, newest: null, days: null }
    const oldest = Math.min(...mtimes)
    const newest = Math.max(...mtimes)
    return {
      fileCount: mtimes.length,
      oldest: new Date(oldest).toISOString(),
      newest: new Date(newest).toISOString(),
      days: Math.round(((newest - oldest) / 86_400_000) * 10) / 10,
    }
  }
  catch {
    return { fileCount: 0, oldest: null, newest: null, days: null }
  }
}

export async function getStorageReport(): Promise<StorageReport> {
  const [persistent, reclaimable, history, dir] = await Promise.all([
    dfPosix(PERSISTENT_ROOT),
    reclaimPlan(),
    rawHistory(),
    dataDir(),
  ])
  const app = await realpath(INSTALL_DIR).catch(() => null)
  const dbFiles = LIVE_DB_FILES.map(f => join(dir, f))
  const reclaimPaths = reclaimable.items.map(i => i.path)
  const sizes = await duMany([ARCHIVE_DIR, ...(app?.startsWith(`${PERSISTENT_ROOT}/`) ? [app] : []), SWAPFILE, ...dbFiles, ...reclaimPaths])

  const size = (p: string) => sizes.get(p) ?? 0
  const known: Array<{ key: SegmentKey, bytes: number }> = [
    { key: 'rawArchive', bytes: size(ARCHIVE_DIR) },
    { key: 'app', bytes: app ? size(app) : 0 },
    { key: 'database', bytes: dbFiles.reduce((s, f) => s + size(f), 0) },
    { key: 'swap', bytes: size(SWAPFILE) },
    // du's own figures: hardlinks shared with the kept release aren't counted twice.
    { key: 'reclaimable', bytes: reclaimPaths.reduce((s, p) => s + size(p), 0) },
  ]
  const used = persistent?.usedBytes ?? 0
  const accounted = known.reduce((s, k) => s + k.bytes, 0)
  return {
    persistent: persistent ?? { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0 },
    prunerTargetPercent: PRUNER_TARGET_PERCENT,
    segments: [...known, { key: 'other', bytes: Math.max(0, used - accounted) }],
    rawHistory: history,
    reclaimable,
  }
}

/**
 * Run sp-storage-cleanup for real. It needs root to remove root-owned
 * leftovers, which the service (User=sleepypod) gets through the
 * sleepypod-storage sudoers fragment.
 */
export async function runStorageCleanup(includeDbBackups: boolean): Promise<{ freedBytes: number, removed: number }> {
  if (!cleanupAvailable()) throw new Error('sp-storage-cleanup is not installed on this pod — update the pod first')
  const args = ['-n', CLEANUP_BIN, '--json', ...(includeDbBackups ? ['--include-db-backups'] : [])]
  const { stdout } = await execFileAsync('sudo', args, { timeout: 180_000 })
  const { items, freedBytes } = parseCleanup(stdout)
  return { freedBytes, removed: items.length }
}
