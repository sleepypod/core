import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'

const BIOMETRICS_DB_PATH = process.env.BIOMETRICS_DATABASE_URL?.replace('file:', '') ?? ''

// Raw waveform sources, in priority order. After the tmpfs migration (#499)
// firmware writes to RAW_TMPFS_DIR; the archiver gzips into RAW_ARCHIVE_DIR.
// RAW_DATA_DIR remains so pre-#499 pods (with *.RAW directly on /persistent)
// still export.
const RAW_TMPFS_DIR = process.env.RAW_TMPFS_DIR ?? '/persistent/biometrics'
const RAW_ARCHIVE_DIR = process.env.RAW_ARCHIVE_DIR ?? '/persistent/biometrics-archive'
const RAW_LEGACY_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

// Staging lives on /persistent (~10 GB free) instead of /tmp (tmpfs, ~1 GB
// shared with RAM-pressured processes). A multi-week export's db backup
// alone can blow past the tmpfs ceiling.
const EXPORT_STAGING_DIR = process.env.EXPORT_STAGING_DIR ?? '/persistent/sleepypod-data/export-staging'

// Accepts <seqno>.RAW (live) or <seqno>.RAW.gz (cold archive).
const SAFE_RAW_NAME = /^[\w.-]+\.RAW(\.gz)?$/i

let inflight = false

// A hung tar (no close/error event) or a client that disconnects mid-stream
// must not leave `inflight` latched (429s until restart) or leak the staging
// dir. Env override exists for tests.
const EXPORT_WATCHDOG_MS = (() => {
  const raw = Number(process.env.EXPORT_WATCHDOG_MS ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60 * 1000
})()

interface SourceFile {
  abs: string
  basename: string
}

/**
 * Walk one source dir for *.RAW or *.RAW.gz whose mtime falls in
 * [startTs, endTs]. Missing dir → []. Same basename across dirs is
 * deduped (tmpfs wins over archive wins over legacy) to avoid two
 * copies of the same waveform window in the tarball.
 */
export async function gatherRawFiles(
  sources: readonly string[],
  startTs: number,
  endTs: number,
): Promise<SourceFile[]> {
  const seen = new Set<string>()
  const out: SourceFile[] = []
  for (const dir of sources) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    }
    catch {
      continue
    }
    for (const name of entries) {
      if (!SAFE_RAW_NAME.test(name)) continue
      if (seen.has(name)) continue
      const full = path.join(dir, name)
      try {
        const s = await stat(full)
        const mtime = Math.floor(s.mtime.getTime() / 1000)
        if (mtime < startTs || mtime > endTs) continue
        seen.add(name)
        out.push({ abs: full, basename: name })
      }
      catch {
        // skip unreadable entry
      }
    }
  }
  return out
}

/**
 * Online backup of a live SQLite database to a destination file. Uses the
 * SQLite Online Backup API via better-sqlite3 — same library next-server
 * already holds the DB open with. Handles WAL correctly, no shell-out, no
 * dependency on a `sqlite3` CLI binary (the pod has neither).
 *
 * Output is a binary .db file rather than a text .sql dump; restore is a
 * literal file copy instead of `sqlite3 < dump.sql`.
 */
async function backupSqlite(dbPath: string, outPath: string): Promise<void> {
  const src = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    await src.backup(outPath)
  }
  finally {
    src.close()
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url)

  if (inflight) {
    return Response.json(
      { error: 'Another export is in progress, retry later' },
      { status: 429, headers: { 'Retry-After': '60' } },
    )
  }

  const startTs = Number(url.searchParams.get('startTs') ?? '0')
  const endTs = Number(url.searchParams.get('endTs') ?? String(Math.floor(Date.now() / 1000)))
  if (Number.isNaN(startTs) || Number.isNaN(endTs)) {
    // A malformed range would silently export everything in [NaN, NaN] → [].
    // Worse, `?startTs=garbage` used to fall through as an all-time export.
    return Response.json(
      { error: 'startTs and endTs must be numeric epoch seconds' },
      { status: 400 },
    )
  }

  inflight = true

  const include = (url.searchParams.get('include') ?? 'raw,db')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  let stagingDir: string | null = null
  try {
    await mkdir(EXPORT_STAGING_DIR, { recursive: true })
    stagingDir = await mkdtemp(path.join(EXPORT_STAGING_DIR, 'sp-export-'))

    if (include.includes('db') && BIOMETRICS_DB_PATH) {
      await backupSqlite(BIOMETRICS_DB_PATH, path.join(stagingDir, 'biometrics.db'))
    }

    if (include.includes('raw')) {
      const rawStaged = path.join(stagingDir, 'raw')
      await mkdir(rawStaged)
      const files = await gatherRawFiles(
        [RAW_TMPFS_DIR, RAW_ARCHIVE_DIR, RAW_LEGACY_DIR],
        startTs,
        endTs,
      )
      for (const f of files) {
        try {
          await symlink(f.abs, path.join(rawStaged, f.basename))
        }
        catch { /* skip duplicates / unreadable */ }
      }
    }

    // -h dereferences symlinks so the archive contains real file contents
    const tarChild = spawn('tar', ['-czhf', '-', '-C', stagingDir, '.'])
    let tarStderr = ''
    tarChild.stderr.on('data', d => (tarStderr += d.toString()))

    const cleanup = () => {
      const dir = stagingDir
      stagingDir = null
      if (dir) rm(dir, { recursive: true, force: true }).catch(() => {})
      inflight = false
    }

    // Both paths kill tar and clean up: a disconnected client stops reading
    // the stream, and a wedged tar never emits close on its own.
    const abortExport = () => {
      tarChild.kill('SIGKILL')
      cleanup()
    }
    const watchdog = setTimeout(abortExport, EXPORT_WATCHDOG_MS)
    request.signal.addEventListener('abort', abortExport, { once: true })
    const settle = () => {
      clearTimeout(watchdog)
      request.signal.removeEventListener('abort', abortExport)
    }

    tarChild.on('close', (code) => {
      settle()
      if (code !== 0 && tarStderr) console.error('tar:', tarStderr)
      cleanup()
    })
    tarChild.on('error', () => {
      settle()
      cleanup()
    })

    const stream = Readable.toWeb(tarChild.stdout) as ReadableStream<Uint8Array>
    const filename = `sleepypod-export-${startTs}-${endTs}.tar.gz`
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  }
  catch (error) {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    inflight = false
    return Response.json(
      { error: error instanceof Error ? error.message : 'Export failed' },
      { status: 500 },
    )
  }
}
