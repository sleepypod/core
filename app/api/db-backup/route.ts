import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import Database from 'better-sqlite3'
import { backupMarkerPath, DB_FILES, type DbKey } from '@/src/lib/dbInspect'

// Staging on /persistent, not /tmp: /tmp is a RAM-backed tmpfs on the pod and
// the biometrics copy alone can be tens of MB.
const EXPORT_STAGING_DIR = process.env.EXPORT_STAGING_DIR ?? '/persistent/sleepypod-data/export-staging'
const WATCHDOG_MS = 10 * 60 * 1000

let inflight = false

/** SQLite online backup: a consistent copy while the pod keeps writing. */
async function backupSqlite(dbPath: string, outPath: string): Promise<void> {
  const src = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    await src.backup(outPath)
  }
  finally {
    src.close()
  }
}

/**
 * GET /api/db-backup — sleepypod.db and biometrics.db as one .tar.gz, taken
 * with SQLite's online backup so services keep running. Restore is a file
 * copy of each .db with sleepypod stopped.
 */
export async function GET(request: Request) {
  if (inflight) {
    return Response.json({ error: 'A backup is already in progress, retry shortly' }, { status: 429, headers: { 'Retry-After': '30' } })
  }
  inflight = true

  let stagingDir: string | null = null
  try {
    await mkdir(EXPORT_STAGING_DIR, { recursive: true })
    stagingDir = await mkdtemp(path.join(EXPORT_STAGING_DIR, 'sp-db-backup-'))
    for (const key of Object.keys(DB_FILES) as DbKey[]) {
      await backupSqlite(DB_FILES[key].path, path.join(stagingDir, `${key}.db`))
    }

    const tarChild = spawn('tar', ['-czf', '-', '-C', stagingDir, 'sleepypod.db', 'biometrics.db'])
    let tarStderr = ''
    tarChild.stderr.on('data', d => (tarStderr += d.toString()))

    const cleanup = () => {
      const dir = stagingDir
      stagingDir = null
      if (dir) rm(dir, { recursive: true, force: true }).catch(() => {})
      inflight = false
    }
    const abort = () => {
      tarChild.kill('SIGKILL')
      cleanup()
    }
    const watchdog = setTimeout(abort, WATCHDOG_MS)
    request.signal.addEventListener('abort', abort, { once: true })
    const settle = () => {
      clearTimeout(watchdog)
      request.signal.removeEventListener('abort', abort)
    }

    tarChild.on('close', (code) => {
      settle()
      if (code === 0) writeFile(backupMarkerPath(), new Date().toISOString()).catch(() => {})
      else if (tarStderr) console.error('[db-backup] tar:', tarStderr)
      cleanup()
    })
    tarChild.on('error', () => {
      settle()
      cleanup()
    })

    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    return new Response(Readable.toWeb(tarChild.stdout) as ReadableStream<Uint8Array>, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="sleepypod-databases-${stamp}.tar.gz"`,
      },
    })
  }
  catch (error) {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true }).catch(() => {})
    inflight = false
    return Response.json({ error: error instanceof Error ? error.message : 'Backup failed' }, { status: 500 })
  }
}
