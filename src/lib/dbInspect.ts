import { createRequire } from 'node:module'
import { readFile, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

/**
 * What System → Databases shows about sleepypod.db and biometrics.db: file and
 * WAL sizes, per-table rows / bytes / last write / hourly writes over the last
 * 24 h, applied migrations, and on-demand integrity checks.
 *
 * The scan (dbstat alone takes ~2.5 s on a pod's biometrics.db) runs read-only
 * on its own connections in a worker thread so it never stalls hardware
 * polling or HTTP, and is cached for a few minutes.
 */

export type DbKey = 'sleepypod' | 'biometrics'

export const DB_FILES: Record<DbKey, { path: string, migrations: string }> = {
  sleepypod: {
    path: process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db',
    migrations: 'src/db/migrations',
  },
  biometrics: {
    path: process.env.BIOMETRICS_DATABASE_URL?.replace(/^file:/, '') || './biometrics.dev.db',
    migrations: 'src/db/biometrics-migrations',
  },
}

/** Columns that date a row, most specific first. */
export const TIME_COLUMNS = ['timestamp', 'fired_at', 'last_seen_at', 'last_checked', 'last_updated', 'updated_at', 'created_at', 'started_at']

export interface TableStats {
  name: string
  rows: number
  /** Table plus its indexes, from dbstat. */
  bytes: number
  timeColumn: string | null
  /** Time values are epoch ms (true) or seconds (false). */
  timeInMs: boolean
  lastWriteAt: number | null
  oldestAt: number | null
  /** Rows written in each of the last 24 hours, oldest first. */
  hourly: number[]
  rows24h: number
}

export interface DbStats {
  key: DbKey
  path: string
  fileBytes: number
  walBytes: number
  pageSize: number
  freePages: number
  walAutocheckpoint: number
  appliedMigrations: number
  lastMigrationAt: number | null
  tables: TableStats[]
  error?: string
}

export interface InspectResult {
  at: number
  /** Start of the first hourly bucket. */
  hoursFrom: number
  databases: DbStats[]
  /** Hours (indexes into `hourly`) when someone was in bed, from sleep_records. */
  occupiedHours: number[]
}

// The worker body. Kept as a string so it runs with plain require() and the
// app's better-sqlite3 build, like the integrity checker.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.modulePath);
const { dbs, timeColumns, hoursFrom, now } = workerData;
const HOUR = 3600000;

function inspect({ key, path }) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 2000');
    const pageSize = db.pragma('page_size', { simple: true });
    const freePages = db.pragma('freelist_count', { simple: true });
    const walAutocheckpoint = db.pragma('wal_autocheckpoint', { simple: true });
    const bytesByTable = new Map();
    try {
      for (const r of db.prepare("SELECT m.tbl_name AS t, SUM(d.pgsize) AS b FROM dbstat d JOIN sqlite_master m ON m.name = d.name GROUP BY m.tbl_name").all()) bytesByTable.set(r.t, r.b);
    } catch {}
    let appliedMigrations = 0, lastMigrationAt = null;
    try {
      const m = db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS last FROM __drizzle_migrations').get();
      appliedMigrations = m.n; lastMigrationAt = m.last;
    } catch {}
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name").all().map(r => r.name);
    const tables = names.map((name) => {
      const q = '"' + name.replace(/"/g, '""') + '"';
      const cols = db.prepare('PRAGMA table_info(' + q + ')').all().map(c => c.name);
      const rows = db.prepare('SELECT COUNT(*) AS n FROM ' + q).get().n;
      const timeColumn = timeColumns.find(c => cols.includes(c)) || null;
      const t = { name, rows, bytes: bytesByTable.get(name) || 0, timeColumn, timeInMs: false, lastWriteAt: null, oldestAt: null, hourly: new Array(24).fill(0), rows24h: 0 };
      if (timeColumn && rows > 0) {
        const c = '"' + timeColumn + '"';
        const r = db.prepare('SELECT MAX(' + c + ') AS hi, MIN(' + c + ') AS lo FROM ' + q + ' WHERE typeof(' + c + ') = \\'integer\\'').get();
        if (r.hi != null) {
          t.timeInMs = r.hi > 1e11;
          const k = t.timeInMs ? 1 : 1000;
          t.lastWriteAt = r.hi * k; t.oldestAt = r.lo * k;
          const from = t.timeInMs ? hoursFrom : Math.floor(hoursFrom / 1000);
          const per = t.timeInMs ? HOUR : 3600;
          // Bound JS numbers are REALs, so floor the bucket explicitly.
          for (const b of db.prepare('SELECT CAST((' + c + ' - ?) / ? AS INTEGER) AS h, COUNT(*) AS n FROM ' + q + ' WHERE ' + c + ' >= ? GROUP BY h').all(from, per, from)) {
            if (b.h >= 0 && b.h < 24) { t.hourly[b.h] += b.n; t.rows24h += b.n; }
          }
        }
      }
      return t;
    });
    let occupiedHours = [];
    if (key === 'biometrics' && names.includes('sleep_records')) {
      const set = new Set();
      const from = Math.floor(hoursFrom / 1000);
      for (const r of db.prepare('SELECT entered_bed_at AS a, left_bed_at AS b FROM sleep_records WHERE left_bed_at >= ?').all(from)) {
        for (let h = Math.max(0, Math.floor((r.a - from) / 3600)); h <= Math.min(23, Math.floor((r.b - from) / 3600)); h++) set.add(h);
      }
      occupiedHours = [...set].sort((a, b) => a - b);
    }
    return { key, pageSize, freePages, walAutocheckpoint, appliedMigrations, lastMigrationAt, tables, occupiedHours };
  } finally { db.close(); }
}

const out = [];
for (const d of dbs) {
  try { out.push(inspect(d)); } catch (e) { out.push({ key: d.key, error: e.message }); }
}
parentPort.postMessage(out);
`

function betterSqlitePath(): string {
  return createRequire(resolve(process.cwd(), 'package.json')).resolve('better-sqlite3')
}

function runWorker<T>(source: string, workerData: unknown, timeoutMs: number): Promise<T> {
  return new Promise((res, rej) => {
    const worker = new Worker(source, { eval: true, workerData })
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      void worker.terminate()
      rej(new Error(`Timed out after ${timeoutMs / 1000}s`))
    }, timeoutMs)
    worker.once('message', (msg: T) => {
      settled = true
      clearTimeout(timer)
      res(msg)
    })
    worker.once('error', (err) => {
      settled = true
      clearTimeout(timer)
      rej(err)
    })
    worker.once('exit', () => {
      clearTimeout(timer)
      if (!settled) rej(new Error('Worker exited without a result'))
    })
  })
}

async function fileBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  }
  catch {
    return 0
  }
}

type WorkerDb = Omit<DbStats, 'path' | 'fileBytes' | 'walBytes'> & { occupiedHours?: number[], error?: string }

const CACHE_MS = 5 * 60_000
const g = globalThis as typeof globalThis & {
  __sp_db_inspect__?: { result: InspectResult | null, pending: Promise<InspectResult> | null }
}
function cache() {
  return g.__sp_db_inspect__ ??= { result: null, pending: null }
}

async function scan(): Promise<InspectResult> {
  const now = Date.now()
  const hour = 3_600_000
  const hoursFrom = Math.floor(now / hour) * hour - 23 * hour
  const keys = Object.keys(DB_FILES) as DbKey[]
  const raw = await runWorker<WorkerDb[]>(WORKER_SOURCE, {
    modulePath: betterSqlitePath(),
    dbs: keys.map(key => ({ key, path: DB_FILES[key].path })),
    timeColumns: TIME_COLUMNS,
    hoursFrom,
    now,
  }, 60_000)
  const databases = await Promise.all(keys.map(async (key) => {
    const r = raw.find(d => d.key === key)
    const path = DB_FILES[key].path
    return {
      key,
      path,
      fileBytes: await fileBytes(path),
      walBytes: await fileBytes(`${path}-wal`),
      pageSize: r?.pageSize ?? 4096,
      freePages: r?.freePages ?? 0,
      walAutocheckpoint: r?.walAutocheckpoint ?? 1000,
      appliedMigrations: r?.appliedMigrations ?? 0,
      lastMigrationAt: r?.lastMigrationAt ?? null,
      tables: r?.tables ?? [],
      ...(r?.error && { error: r.error }),
    } satisfies DbStats
  }))
  return { at: now, hoursFrom, databases, occupiedHours: raw.find(d => d.key === 'biometrics')?.occupiedHours ?? [] }
}

/** Cached scan; `fresh` forces a new one. Concurrent callers share one worker. */
export async function inspectDatabases(fresh = false): Promise<InspectResult> {
  const c = cache()
  if (!fresh && c.result && Date.now() - c.result.at < CACHE_MS) return c.result
  c.pending ??= scan().then((r) => {
    c.result = r
    return r
  }).finally(() => {
    c.pending = null
  })
  return c.pending
}

// ── Migrations ───────────────────────────────────────────────────────────────

export interface MigrationInfo {
  known: number
  /** Tag of the newest migration this build ships ("0016_hardware_deadline"). */
  latestTag: string | null
  /** Tag matching the newest applied migration, when this build knows it. */
  appliedTag: string | null
}

export async function migrationInfo(key: DbKey, lastAppliedAt: number | null): Promise<MigrationInfo> {
  try {
    const journal = JSON.parse(await readFile(resolve(process.cwd(), DB_FILES[key].migrations, 'meta/_journal.json'), 'utf-8')) as { entries: Array<{ tag: string, when: number }> }
    const entries = journal.entries ?? []
    return {
      known: entries.length,
      latestTag: entries[entries.length - 1]?.tag ?? null,
      appliedTag: entries.find(e => e.when === lastAppliedAt)?.tag ?? null,
    }
  }
  catch {
    return { known: 0, latestTag: null, appliedTag: null }
  }
}

// ── Integrity ────────────────────────────────────────────────────────────────

export interface IntegrityRun {
  status: 'ok' | 'degraded'
  checkedAt: string
  latencyMs: number
  error?: string
}

const INTEGRITY_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const Database = require(workerData.modulePath);
const out = {};
for (const { key, path } of workerData.dbs) {
  const started = Date.now();
  let db;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 1000');
    const r = db.pragma('quick_check(1)', { simple: true });
    out[key] = { ok: r === 'ok', error: r === 'ok' ? undefined : String(r), ms: Date.now() - started };
  } catch (e) { out[key] = { ok: false, error: e.message, ms: Date.now() - started }; }
  finally { if (db) db.close(); }
}
parentPort.postMessage(out);
`

const integrityState = globalThis as typeof globalThis & { __sp_db_manual_integrity__?: Partial<Record<DbKey, IntegrityRun>> }

/** Results of on-demand checks since the server started. */
export function manualIntegrity(): Partial<Record<DbKey, IntegrityRun>> {
  return { ...integrityState.__sp_db_manual_integrity__ }
}

/** quick_check both databases now, off the main thread. */
export async function runIntegrityChecks(): Promise<Partial<Record<DbKey, IntegrityRun>>> {
  const keys = Object.keys(DB_FILES) as DbKey[]
  const res = await runWorker<Record<DbKey, { ok: boolean, error?: string, ms: number }>>(INTEGRITY_SOURCE, {
    modulePath: betterSqlitePath(),
    dbs: keys.map(key => ({ key, path: DB_FILES[key].path })),
  }, 120_000)
  const at = new Date().toISOString()
  const runs: Partial<Record<DbKey, IntegrityRun>> = {}
  for (const key of keys) {
    const r = res[key]
    if (!r) continue
    runs[key] = { status: r.ok ? 'ok' : 'degraded', checkedAt: at, latencyMs: r.ms, ...(r.error && { error: r.error }) }
  }
  integrityState.__sp_db_manual_integrity__ = { ...integrityState.__sp_db_manual_integrity__, ...runs }
  return runs
}

// ── Backups ──────────────────────────────────────────────────────────────────

/** Marker touched after each downloaded backup, next to the databases. */
export function backupMarkerPath(): string {
  return resolve(dirname(DB_FILES.sleepypod.path), '.last-backup')
}

export async function lastBackupAt(): Promise<number | null> {
  try {
    return (await stat(backupMarkerPath())).mtimeMs
  }
  catch {
    return null
  }
}
