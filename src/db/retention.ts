import Database from 'better-sqlite3'
import { lt, sql } from 'drizzle-orm'
import { biometricsDb } from './biometrics'
import {
  ambientLight,
  bedTemp,
  flowReadings,
  freezerTemp,
  movement,
  vitals,
  waterLevelReadings,
} from './biometrics-schema'

/**
 * Data retention for the biometrics time-series tables.
 *
 * Pod embedded storage is ~1.3 GB free; high-frequency sensor tables grow
 * ~3–5 MB/day. Without cleanup, biometrics.db exceeds 1 GB within a year.
 * This job deletes rows older than the configured retention window and
 * reclaims file-system space via incremental_vacuum afterwards.
 *
 * Tables covered (all write at ≥1/minute and have no referential joins):
 *   vitals, movement, bed_temp, freezer_temp, flow_readings,
 *   ambient_light, water_level_readings
 *
 * NOT covered (deliberately):
 *   sleep_records     — derived summaries, low volume, keep indefinitely
 *   water_level_alerts — user-facing events, low volume, keep indefinitely
 *   calibration_*     — small, correctness-critical, keep indefinitely
 *   vitals_quality    — small per-sample diagnostics, retention handled
 *                       by the owning module
 */

const RETENTION_TABLES = [
  { table: vitals, column: vitals.timestamp, name: 'vitals' },
  { table: movement, column: movement.timestamp, name: 'movement' },
  { table: bedTemp, column: bedTemp.timestamp, name: 'bed_temp' },
  { table: freezerTemp, column: freezerTemp.timestamp, name: 'freezer_temp' },
  { table: flowReadings, column: flowReadings.timestamp, name: 'flow_readings' },
  { table: ambientLight, column: ambientLight.timestamp, name: 'ambient_light' },
  { table: waterLevelReadings, column: waterLevelReadings.timestamp, name: 'water_level_readings' },
] as const

export interface RetentionResult {
  /** Total rows deleted across all tables. */
  rowsDeleted: number
  /** Per-table delete counts, for logging/tests. */
  perTable: Record<string, number>
}

/**
 * Delete rows older than `cutoff` from all retention-managed tables.
 *
 * Accepts an optional drizzle handle so tests can inject an isolated DB
 * instance. Production callers should pass the shared `biometricsDb`.
 */
export function pruneOldBiometrics(
  cutoff: Date,
  db: typeof biometricsDb = biometricsDb,
): RetentionResult {
  const perTable: Record<string, number> = {}
  let total = 0

  for (const { table, column, name } of RETENTION_TABLES) {
    const result = db.delete(table).where(lt(column, cutoff)).run()
    const deleted = Number(result.changes ?? 0)
    perTable[name] = deleted
    total += deleted
  }

  return { rowsDeleted: total, perTable }
}

/**
 * Enable auto_vacuum = INCREMENTAL on a fresh biometrics DB. This is a
 * no-op on existing databases because SQLite only honours the pragma when
 * set before any table is created; we still issue it defensively so
 * newly-provisioned pods get space reclamation for free.
 */
export function configureAutoVacuum(dbFilePath: string): void {
  const raw = new Database(dbFilePath)
  try {
    raw.pragma('auto_vacuum = INCREMENTAL')
  }
  finally {
    raw.close()
  }
}

/**
 * Run one retention pass: prune old rows and attempt to reclaim space.
 * Safe to call on a loop from a startup hook.
 */
export function runRetentionPass(retentionDays: number): RetentionResult {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) {
    throw new Error(`retentionDays must be a positive finite number (got ${retentionDays})`)
  }
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
  const result = pruneOldBiometrics(cutoff)

  if (result.rowsDeleted > 0) {
    // incremental_vacuum is a no-op on non-incremental databases, so this
    // is always safe even when auto_vacuum wasn't configured at init.
    try {
      biometricsDb.run(sql`PRAGMA incremental_vacuum`)
    }
    catch (err) {
      console.warn('[retention] incremental_vacuum failed:', err instanceof Error ? err.message : err)
    }
  }

  return result
}

let retentionTimer: NodeJS.Timeout | null = null

/**
 * Start the background retention loop.
 *
 * Defaults chosen for embedded deployment:
 *   retentionDays = 90   (≈270–450 MB of time-series at 3–5 MB/day)
 *   intervalHours = 24   (once-daily is enough; deletes are cheap)
 *
 * Both are overridable by env so an operator can tune without a deploy.
 * Runs an initial pass after a 30s delay to avoid fighting startup I/O.
 *
 * Idempotent — a second call is a no-op until `stopBiometricsRetention`.
 */
export function startBiometricsRetention(options?: {
  retentionDays?: number
  intervalHours?: number
  initialDelayMs?: number
}): void {
  if (retentionTimer) return

  const retentionDays = options?.retentionDays
    ?? Number(process.env.BIOMETRICS_RETENTION_DAYS ?? 90)

  // Coerce/validate so a malformed env var (NaN, 0, negative) doesn't
  // produce a near-zero setInterval delay that hammers the DB. Fall
  // back to the documented 24h default in that case.
  const rawIntervalHours = options?.intervalHours
    ?? Number(process.env.BIOMETRICS_RETENTION_INTERVAL_HOURS ?? 24)
  const intervalHours = Number.isFinite(rawIntervalHours) && rawIntervalHours > 0
    ? rawIntervalHours
    : 24

  const initialDelayMs = options?.initialDelayMs ?? 30_000

  const runOnce = () => {
    try {
      const result = runRetentionPass(retentionDays)
      if (result.rowsDeleted > 0) {
        console.log(
          `[retention] Pruned ${result.rowsDeleted} biometrics rows older than ${retentionDays}d:`,
          result.perTable,
        )
      }
    }
    catch (err) {
      console.error('[retention] pass failed:', err instanceof Error ? err.message : err)
    }
  }

  const intervalMs = intervalHours * 3_600_000
  const initialTimer = setTimeout(() => {
    runOnce()
    retentionTimer = setInterval(runOnce, intervalMs)
    retentionTimer.unref()
  }, initialDelayMs)
  initialTimer.unref()

  retentionTimer = initialTimer
}

export function stopBiometricsRetention(): void {
  if (retentionTimer) {
    clearTimeout(retentionTimer)
    clearInterval(retentionTimer)
    retentionTimer = null
  }
}
