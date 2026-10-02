import { and, desc, gte, inArray, lte } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { healthRuns } from '@/src/db/biometrics-schema'
import type * as biometricsSchema from '@/src/db/biometrics-schema'
import { NODES, type CheckStatus, type NodeId } from '@/src/lib/dataPath'

/**
 * 24-hour history for System → Health, stored as runs of one status per
 * check (see health_runs). Recording runs rather than per-minute samples
 * keeps a quiet day to ~15 rows, and makes incidents fall straight out.
 */

type Db = BetterSQLite3Database<typeof biometricsSchema>

export const SAMPLE_INTERVAL_MS = 60_000
/** A run whose last sample is older than this has ended; the gap after it is unrecorded. */
const CONTINUE_WITHIN_MS = 3 * SAMPLE_INTERVAL_MS
export const HISTORY_WINDOW_MS = 24 * 3_600_000
/** Incidents separated by less than this are one flapping incident. */
const MERGE_GAP_MS = 2 * SAMPLE_INTERVAL_MS

export interface OpenRun { id: number, status: CheckStatus, lastSeenAt: number }

export interface Sample { id: NodeId, status: CheckStatus, detail: string }

/** Resume runs the previous process left open, if it stopped moments ago. */
export function loadOpenRuns(db: Db, now: number): Map<string, OpenRun> {
  const open = new Map<string, OpenRun>()
  const since = new Date(now - CONTINUE_WITHIN_MS)
  const rows = db.select().from(healthRuns).where(gte(healthRuns.lastSeenAt, since)).orderBy(desc(healthRuns.lastSeenAt)).all()
  for (const r of rows) {
    if (!open.has(r.checkId)) open.set(r.checkId, { id: r.id, status: r.status, lastSeenAt: r.lastSeenAt.getTime() })
  }
  return open
}

/**
 * Fold one evaluation into the runs: extend a check's open run while its
 * status holds, otherwise start a new run that begins where the last ended
 * (or now, after an unrecorded gap).
 */
export function recordSample(db: Db, open: Map<string, OpenRun>, samples: Sample[], now: number): void {
  const at = new Date(now)
  db.transaction((tx) => {
    const extend: number[] = []
    for (const s of samples) {
      const prev = open.get(s.id)
      const contiguous = prev != null && now - prev.lastSeenAt <= CONTINUE_WITHIN_MS
      if (contiguous && prev.status === s.status) {
        extend.push(prev.id)
        prev.lastSeenAt = now
        continue
      }
      const startedAt = contiguous ? new Date(prev.lastSeenAt) : at
      const [row] = tx.insert(healthRuns)
        .values({ checkId: s.id, status: s.status, detail: s.detail, startedAt, lastSeenAt: at })
        .returning({ id: healthRuns.id })
        .all()
      open.set(s.id, { id: row.id, status: s.status, lastSeenAt: now })
    }
    if (extend.length) tx.update(healthRuns).set({ lastSeenAt: at }).where(inArray(healthRuns.id, extend)).run()
  })
}

export interface HistoryRun { status: CheckStatus, start: number, end: number }

export interface Incident {
  checkId: NodeId
  label: string
  status: 'stale' | 'down'
  start: number
  /** null while it is still happening. */
  end: number | null
  detail: string | null
}

export interface HealthHistory {
  from: number
  to: number
  /** Earliest recorded moment in the window, or null when nothing is recorded yet. */
  recordedSince: number | null
  checks: Array<{
    id: NodeId
    label: string
    runs: HistoryRun[]
    /** Share of known recorded time that was ok or idle (0–1), null when none is known. */
    healthyShare: number | null
    incidents: number
  }>
  incidents: Incident[]
  /** Stretches no check was sampled — the core itself wasn't running. */
  gaps: Array<{ start: number, end: number }>
}

export function readHistory(db: Db, now: number, windowMs = HISTORY_WINDOW_MS): HealthHistory {
  const from = now - windowMs
  const rows = db.select().from(healthRuns)
    .where(and(gte(healthRuns.lastSeenAt, new Date(from)), lte(healthRuns.startedAt, new Date(now))))
    .orderBy(healthRuns.startedAt)
    .all()

  const labels = new Map(NODES.map(n => [n.id, n.label]))
  const byCheck = new Map<NodeId, typeof rows>()
  for (const r of rows) {
    if (!labels.has(r.checkId as NodeId)) continue
    const list = byCheck.get(r.checkId as NodeId) ?? []
    list.push(r)
    byCheck.set(r.checkId as NodeId, list)
  }

  const incidents: Incident[] = []
  const checks = NODES.map((n) => {
    const own = byCheck.get(n.id) ?? []
    // Only the newest run can still be open; an older one ended when the
    // status changed, even if that was moments ago.
    const isOpen = (idx: number) => idx === own.length - 1 && own[idx].lastSeenAt.getTime() >= now - CONTINUE_WITHIN_MS
    const runs = own.map((r, idx) => ({
      status: r.status,
      start: Math.max(from, r.startedAt.getTime()),
      // The open run reaches "now" — the next sample is under a minute away.
      end: Math.min(now, isOpen(idx) ? now : r.lastSeenAt.getTime()),
    }))
    let recorded = 0
    let healthy = 0
    for (const r of runs) {
      if (r.status === 'unknown') continue
      const d = Math.max(0, r.end - r.start)
      recorded += d
      if (r.status === 'ok' || r.status === 'idle') healthy += d
    }

    const ownIncidents: Incident[] = []
    own.forEach((r, idx) => {
      if (r.status !== 'stale' && r.status !== 'down') return
      const run = runs[idx]
      const ongoing = isOpen(idx)
      const last = ownIncidents[ownIncidents.length - 1]
      if (last && last.status === r.status && last.end != null && run.start - last.end <= MERGE_GAP_MS) {
        last.end = ongoing ? null : run.end
        return
      }
      ownIncidents.push({ checkId: n.id, label: n.label, status: r.status, start: run.start, end: ongoing ? null : run.end, detail: r.detail })
    })
    incidents.push(...ownIncidents)

    return {
      id: n.id,
      label: n.label,
      runs,
      healthyShare: recorded > 0 ? healthy / recorded : null,
      incidents: ownIncidents.length,
    }
  })

  // Unrecorded stretches: time between runs that every check misses.
  const spans = checks.flatMap(c => c.runs).map(r => [r.start, r.end] as const).sort((a, b) => a[0] - b[0])
  const gaps: HealthHistory['gaps'] = []
  let cursor: number | null = null
  for (const [s, e] of spans) {
    if (cursor != null && s - cursor > CONTINUE_WITHIN_MS) gaps.push({ start: cursor, end: s })
    cursor = cursor == null ? e : Math.max(cursor, e)
  }
  if (cursor != null && now - cursor > CONTINUE_WITHIN_MS) gaps.push({ start: cursor, end: now })

  incidents.sort((a, b) => (b.end ?? now) - (a.end ?? now) || b.start - a.start)
  return {
    from,
    to: now,
    recordedSince: spans.length ? spans[0][0] : null,
    checks,
    incidents,
    gaps,
  }
}
