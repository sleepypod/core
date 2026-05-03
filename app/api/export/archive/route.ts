import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'

const EXPORT_TOKEN = process.env.EXPORT_TOKEN
const BIOMETRICS_DB_PATH = process.env.BIOMETRICS_DATABASE_URL?.replace('file:', '') ?? ''
const RAW_DIR = process.env.RAW_DATA_DIR ?? '/persistent'

const SAFE_FILENAME = /^[\w.-]+\.RAW$/i

let inflight = false

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

  if (!EXPORT_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const token = url.searchParams.get('token')
  if (!token || token !== EXPORT_TOKEN) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
      let entries: string[] = []
      try {
        entries = await readdir(RAW_DIR)
      }
      catch { /* RAW_DIR missing — ok, archive will have empty raw/ */ }
      for (const name of entries) {
        if (!SAFE_FILENAME.test(name)) continue
        const full = path.join(RAW_DIR, name)
        try {
          const s = await stat(full)
          const mtime = Math.floor(s.mtime.getTime() / 1000)
          if (mtime < startTs || mtime > endTs) continue
          await symlink(full, path.join(rawStaged, name))
        }
        catch { /* skip unreadable entry */ }
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
