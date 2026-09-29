import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

export interface IntegrityStatus {
  status: 'pending' | 'ok' | 'degraded'
  checkedAt: string | null
  latencyMs: number
  error?: string
}
type DatabaseKey = 'sleepypod' | 'biometrics'
export type DatabaseIntegrityByDb = Record<DatabaseKey, IntegrityStatus>

const DATABASES: { key: DatabaseKey, label: string, path: () => string }[] = [
  { key: 'sleepypod', label: 'sleepypod.db', path: () => process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db' },
  { key: 'biometrics', label: 'biometrics.db', path: () => process.env.BIOMETRICS_DATABASE_URL?.replace(/^file:/, '') || './biometrics.dev.db' },
]
// Per-database budget; the run's timeout scales with the number of files.
const TIMEOUT_PER_DB_MS = 30_000

const pending = (): IntegrityStatus => ({ status: 'pending', checkedAt: null, latencyMs: 0 })
const globalState = globalThis as typeof globalThis & {
  __sp_database_integrity__?: {
    results: DatabaseIntegrityByDb
    timer: ReturnType<typeof setTimeout> | null
    worker: Worker | null
    stopped: boolean
  }
}
function state() {
  return globalState.__sp_database_integrity__ ??= {
    results: { sleepypod: pending(), biometrics: pending() }, timer: null, worker: null, stopped: false,
  }
}

export function getDatabaseIntegrityByDb(): DatabaseIntegrityByDb {
  const { results } = state()
  return { sleepypod: { ...results.sleepypod }, biometrics: { ...results.biometrics } }
}

/** Combined view: degraded if any file is, pending until every file ran once;
 * checkedAt is the oldest check, latencyMs the total. */
export function getDatabaseIntegrity(): IntegrityStatus {
  const results = state().results
  const all = DATABASES.map(d => ({ label: d.label, result: results[d.key] }))
  const latencyMs = all.reduce((sum, d) => sum + d.result.latencyMs, 0)
  const checked = all.map(d => d.result.checkedAt)
  const checkedAt = checked.includes(null) ? null : (checked as string[]).sort()[0]
  const degraded = all.filter(d => d.result.status === 'degraded')
  if (degraded.length) {
    return {
      status: 'degraded', checkedAt, latencyMs,
      error: degraded.map(d => `${d.label}: ${d.result.error ?? 'integrity check failed'}`).join('; '),
    }
  }
  return { status: checkedAt ? 'ok' : 'pending', checkedAt, latencyMs }
}

/** Full scans run on separate SQLite connections in a worker so even the
 * first check cannot stall hardware polling or HTTP. Read-only, once an hour;
 * each file is checked in turn within the same worker run. */
export function startDatabaseIntegrityChecks(): void {
  const s = state()
  if (s.timer || s.worker) return
  s.stopped = false
  const schedule = (delay: number) => {
    s.timer = setTimeout(run, delay)
    s.timer.unref()
  }
  const run = () => {
    s.timer = null
    if (s.stopped) return
    const startedAt = performance.now()
    const received: Partial<Record<DatabaseKey, IntegrityStatus>> = {}
    const finish = (error?: string) => {
      clearTimeout(timeout)
      s.worker = null
      if (s.stopped) return
      const checkedAt = new Date().toISOString()
      const elapsed = Math.round(performance.now() - startedAt)
      const accounted = Object.values(received).reduce((sum, r) => sum + r.latencyMs, 0)
      for (const d of DATABASES) {
        // Files the worker never reported on inherit the run's failure.
        const result = received[d.key] ?? {
          status: 'degraded', checkedAt, latencyMs: Math.max(0, elapsed - accounted),
          error: error ?? 'Integrity worker exited without a result',
        }
        s.results[d.key] = result
        if (result.error) console.warn(`[database] Integrity check failed for ${d.label}:`, result.error)
      }
      schedule(60 * 60_000)
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const require = createRequire(resolve(process.cwd(), 'package.json'))
      const databases = DATABASES.map(d => ({ key: d.key, path: d.path() }))
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.modulePath);
        for (const { key, path } of workerData.databases) {
          const startedAt = performance.now();
          let db, error = null;
          try {
            db = new Database(path, { readonly: true, fileMustExist: true });
            db.pragma('busy_timeout = 1000');
            const result = db.pragma('quick_check(1)', { simple: true });
            if (result !== 'ok') error = String(result);
          } catch (e) { error = e.message; }
          finally { if (db) db.close(); }
          parentPort.postMessage({ key, error, latencyMs: Math.round(performance.now() - startedAt) });
        }
      `, {
        eval: true,
        workerData: { modulePath: require.resolve('better-sqlite3'), databases },
      })
      s.worker = worker
      let failure: string | undefined
      worker.on('message', (message: { key: DatabaseKey, error: string | null, latencyMs: number }) => {
        received[message.key] = {
          status: message.error ? 'degraded' : 'ok', checkedAt: new Date().toISOString(),
          latencyMs: message.latencyMs, ...(message.error && { error: message.error }),
        }
      })
      worker.once('error', (error) => {
        failure = error instanceof Error ? error.message : String(error)
      })
      worker.once('exit', () => finish(failure))
      const limitMs = TIMEOUT_PER_DB_MS * databases.length
      timeout = setTimeout(() => {
        failure = `Integrity check timed out after ${limitMs / 1000}s`
        void worker.terminate()
      }, limitMs)
      timeout.unref()
      worker.unref()
    }
    catch (error) {
      finish(error instanceof Error ? error.message : String(error))
    }
  }
  // Let startup settle; no scan is performed in instrumentation or an API call.
  schedule(30_000)
}

export async function stopDatabaseIntegrityChecks(): Promise<void> {
  const s = state()
  s.stopped = true
  if (s.timer) clearTimeout(s.timer)
  s.timer = null
  if (s.worker) await s.worker.terminate()
  s.worker = null
}
