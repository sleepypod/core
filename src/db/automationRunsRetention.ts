import type Database from 'better-sqlite3'
import { sqlite } from './index'

/**
 * Data retention for automation_runs (main sleepypod.db).
 *
 * The engine logs a row per evaluation (fired/skipped/clamped/…), so a pod
 * with a few rules accrues ~100 KB/day indefinitely. Nothing needs rows older
 * than a month: cooldown and the runaway guard are in-memory (engine.ts),
 * `status` reads the latest row + today, `diagnostics` ≤ 24 h, `tonight`
 * 12 h, `activity` ≤ 30 nights. 90 days leaves headroom over all of them.
 *
 * fired_at is drizzle `mode: 'timestamp'`: epoch seconds, written by the
 * `unixepoch()` default.
 *
 * Deletes go in rowid batches with an event-loop yield between them, so a
 * first pass over 100k+ rows never holds the write lock for long. No index on
 * fired_at: old rows sit at the low end of rowid order, so each batch's scan
 * finds them immediately; only the last batch walks the whole table, once a
 * day.
 */

/** Table the daily pass prunes, for System → Databases. */
export const AUTOMATION_RUNS_TABLE_NAME = 'automation_runs'

const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_BATCH_SIZE = 5_000

/** The retention window the loop uses when started without options. */
export function configuredAutomationRunsRetentionDays(): number {
  const days = Number(process.env.AUTOMATION_RUNS_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS)
  return Number.isFinite(days) && days > 0 ? days : DEFAULT_RETENTION_DAYS
}

/**
 * Delete automation_runs rows older than `cutoff`, `batchSize` rows per
 * statement. Accepts a raw handle so tests can inject an isolated DB.
 */
export async function pruneOldAutomationRuns(
  cutoff: Date,
  db: Database.Database = sqlite,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const cutoffSec = Math.floor(cutoff.getTime() / 1000)
  const stmt = db.prepare(`
    DELETE FROM ${AUTOMATION_RUNS_TABLE_NAME} WHERE rowid IN (
      SELECT rowid FROM ${AUTOMATION_RUNS_TABLE_NAME}
      WHERE fired_at < ?
      LIMIT ?
    )
  `)

  let total = 0
  for (;;) {
    // Shutdown may close the handle while we're yielded.
    if (!db.open) break
    const deleted = Number(stmt.run(cutoffSec, batchSize).changes)
    total += deleted
    if (deleted < batchSize) break
    await new Promise(resolve => setImmediate(resolve))
  }
  return total
}

let retentionTimer: NodeJS.Timeout | null = null

/**
 * Start the background automation_runs retention loop: first pass after 30 s,
 * then every 24 h. Idempotent — a second call is a no-op until
 * `stopAutomationRunsRetention`.
 */
export function startAutomationRunsRetention(options?: {
  retentionDays?: number
  intervalHours?: number
  initialDelayMs?: number
  batchSize?: number
  db?: Database.Database
}): void {
  if (retentionTimer) return

  const rawDays = options?.retentionDays ?? configuredAutomationRunsRetentionDays()
  const retentionDays = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : DEFAULT_RETENTION_DAYS
  const rawIntervalHours = options?.intervalHours ?? 24
  const intervalHours = Number.isFinite(rawIntervalHours) && rawIntervalHours > 0 ? rawIntervalHours : 24
  const initialDelayMs = options?.initialDelayMs ?? 30_000

  let running = false
  const runOnce = async () => {
    if (running) return
    running = true
    try {
      const cutoff = new Date(Date.now() - retentionDays * 86_400_000)
      const deleted = await pruneOldAutomationRuns(cutoff, options?.db ?? sqlite, options?.batchSize)
      if (deleted > 0) {
        console.log(`[retention] Pruned ${deleted} automation_runs rows older than ${retentionDays}d`)
      }
    }
    catch (err) {
      console.error('[retention] automation_runs pass failed:', err instanceof Error ? err.message : err)
    }
    finally {
      running = false
    }
  }

  const initialTimer = setTimeout(() => {
    void runOnce()
    retentionTimer = setInterval(() => void runOnce(), intervalHours * 3_600_000)
    retentionTimer.unref()
  }, initialDelayMs)
  initialTimer.unref()

  retentionTimer = initialTimer
}

export function stopAutomationRunsRetention(): void {
  if (retentionTimer) {
    clearTimeout(retentionTimer)
    clearInterval(retentionTimer)
    retentionTimer = null
  }
}
