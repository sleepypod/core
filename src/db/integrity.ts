import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

interface IntegrityStatus {
  status: 'pending' | 'ok' | 'degraded'
  checkedAt: string | null
  latencyMs: number
  error?: string
}
const globalState = globalThis as typeof globalThis & {
  __sp_database_integrity__?: {
    result: IntegrityStatus
    timer: ReturnType<typeof setTimeout> | null
    worker: Worker | null
    stopped: boolean
  }
}
function state() {
  return globalState.__sp_database_integrity__ ??= {
    result: { status: 'pending', checkedAt: null, latencyMs: 0 }, timer: null, worker: null, stopped: false,
  }
}

export function getDatabaseIntegrity(): IntegrityStatus {
  return { ...state().result }
}

/** Full scans run on a separate SQLite connection in a worker so even the
 * first check cannot stall hardware polling or HTTP. Read-only, once an hour. */
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
    const finish = (error?: string) => {
      clearTimeout(timeout)
      s.worker = null
      if (s.stopped) return
      s.result = {
        status: error ? 'degraded' : 'ok', checkedAt: new Date().toISOString(),
        latencyMs: Math.round(performance.now() - startedAt), ...(error && { error }),
      }
      if (error) console.warn('[database] Integrity check failed:', error)
      schedule(60 * 60_000)
    }
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const require = createRequire(resolve(process.cwd(), 'package.json'))
      const worker = new Worker(`
        const { parentPort, workerData } = require('node:worker_threads');
        const Database = require(workerData.modulePath);
        let db;
        try {
          db = new Database(workerData.path, { readonly: true, fileMustExist: true });
          db.pragma('busy_timeout = 1000');
          const result = db.pragma('quick_check(1)', { simple: true });
          parentPort.postMessage(result === 'ok' ? null : String(result));
        } catch (error) { parentPort.postMessage(error.message); }
        finally { if (db) db.close(); }
      `, {
        eval: true,
        workerData: {
          modulePath: require.resolve('better-sqlite3'),
          path: process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db',
        },
      })
      s.worker = worker
      let result: string | undefined = 'Integrity worker exited without a result'
      worker.once('message', (error: string | null) => {
        result = error ?? undefined
      })
      worker.once('error', (error) => {
        result = error instanceof Error ? error.message : String(error)
      })
      worker.once('exit', () => finish(result))
      timeout = setTimeout(() => {
        result = 'Integrity check timed out after 30s'
        void worker.terminate()
      }, 30_000)
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
