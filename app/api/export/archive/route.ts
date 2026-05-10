import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const BIOMETRICS_DB_PATH = process.env.BIOMETRICS_DATABASE_URL?.replace('file:', '') ?? ''

// Raw waveform sources, in priority order. After the tmpfs migration (#499)
// firmware writes to RAW_TMPFS_DIR; the archiver gzips into RAW_ARCHIVE_DIR.
// RAW_DATA_DIR remains so pre-#499 pods (with *.RAW directly on /persistent)
// still export.
const RAW_TMPFS_DIR = process.env.RAW_TMPFS_DIR ?? '/persistent/biometrics'
const RAW_ARCHIVE_DIR = process.env.RAW_ARCHIVE_DIR ?? '/persistent/biometrics-archive'
const RAW_LEGACY_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

// Accepts <seqno>.RAW (live) or <seqno>.RAW.gz (cold archive).
const SAFE_RAW_NAME = /^[\w.-]+\.RAW(\.gz)?$/i

let inflight = false

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

async function dumpSqlite(dbPath: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(outPath)
    const child = spawn('sqlite3', [dbPath, '.dump'])
    child.stdout.pipe(out)
    let stderr = ''
    child.stderr.on('data', d => (stderr += d.toString()))
    child.on('error', reject)
    child.on('close', (code) => {
      out.close(() => {
        if (code === 0) resolve()
        else reject(new Error(`sqlite3 .dump exited with ${code}: ${stderr}`))
      })
    })
  })
}

export async function GET(request: Request) {
  const url = new URL(request.url)

  if (inflight) {
    return Response.json(
      { error: 'Another export is in progress, retry later' },
      { status: 429, headers: { 'Retry-After': '60' } },
    )
  }
  inflight = true

  const startTs = Number(url.searchParams.get('startTs') ?? '0')
  const endTs = Number(url.searchParams.get('endTs') ?? String(Math.floor(Date.now() / 1000)))
  const include = (url.searchParams.get('include') ?? 'raw,db')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)

  let stagingDir: string | null = null
  try {
    stagingDir = await mkdtemp(path.join(tmpdir(), 'sp-export-'))

    if (include.includes('db') && BIOMETRICS_DB_PATH) {
      await dumpSqlite(BIOMETRICS_DB_PATH, path.join(stagingDir, 'biometrics.sql'))
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
    tarChild.on('close', (code) => {
      if (code !== 0 && tarStderr) console.error('tar:', tarStderr)
      cleanup()
    })
    tarChild.on('error', cleanup)

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
