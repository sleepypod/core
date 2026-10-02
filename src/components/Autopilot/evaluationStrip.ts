/**
 * Evaluation strip + grouped run log for Autopilot Diagnostics — pure
 * derivations over the compact run rows `automations.diagnostics` returns.
 *
 * The engine writes one row per triggered evaluation (skipped / dry_run /
 * fired / clamped / error; a cooldown skip is `skipped` + reason "cooldown").
 * "Missing" is inferred, not logged: only a `tick` trigger has an expected
 * cadence, so only it can have minutes where an evaluation should have landed
 * and didn't. Rows record no condition values, so groups carry reasons, not
 * value ranges.
 */

import type { Condition, Expr, Trigger } from '@/src/automation/types'

export type RunOutcome = 'fired' | 'skipped' | 'clamped' | 'dry_run' | 'error'

export interface EvalRun {
  t: Date | string
  outcome: RunOutcome
  reason: string | null
  sent: boolean
}

export type TickKind = 'skipped' | 'would' | 'fired' | 'cooldown' | 'error' | 'missing' | 'none'

/** Paint priority when several evaluations share a minute. */
const RANK: Record<TickKind, number> = { none: 0, missing: 1, skipped: 2, cooldown: 3, error: 4, would: 5, fired: 6 }

const MIN = 60_000
/** Slack before a late tick counts as missing (setInterval drift, slow ticks). */
const GRACE_MS = 45_000

export function toMs(t: Date | string): number {
  return (t instanceof Date ? t : new Date(t)).getTime()
}

export function runKind(r: Pick<EvalRun, 'outcome' | 'reason'>): Exclude<TickKind, 'missing' | 'none'> {
  if (r.outcome === 'dry_run') return 'would'
  if (r.outcome === 'fired' || r.outcome === 'clamped') return 'fired'
  if (r.outcome === 'error') return 'error'
  return r.reason === 'cooldown' ? 'cooldown' : 'skipped'
}

/**
 * Start times (ms) of expected-but-absent `tick` evaluations in [fromMs, nowMs].
 * Gaps are measured between consecutive recorded evaluations (and from the
 * last one to now); nothing before the first recorded row is flagged, since
 * the rule may not have existed or been enabled yet.
 */
export function missingTicks(runs: EvalRun[], trigger: Trigger, fromMs: number, nowMs: number): number[] {
  if (trigger.kind !== 'tick' || runs.length === 0) return []
  const step = Math.max(1, trigger.everyMin) * MIN
  const times = runs.map(r => toMs(r.t)).sort((a, b) => a - b)
  times.push(nowMs)
  const out: number[] = []
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i]
    const b = times[i + 1]
    if (b - a <= step + GRACE_MS) continue
    for (let t = a + step; t < b - GRACE_MS + 1; t += step) {
      if (t >= fromMs && t <= nowMs) out.push(t)
    }
  }
  return out
}

export interface Strip {
  startMs: number
  endMs: number
  ticks: TickKind[]
  /** Contiguous cooldown spans as [firstIndex, lastIndex] (inclusive). */
  cooldowns: Array<[number, number]>
}

/** One slot per minute across the `hours` before `nowMs`; `missing` only when `expectMissing`. */
export function buildStrip(runs: EvalRun[], trigger: Trigger, nowMs: number, hours: number, expectMissing: boolean): Strip {
  const slots = hours * 60
  const endMs = Math.floor(nowMs / MIN) * MIN + MIN
  const startMs = endMs - slots * MIN
  const ticks: TickKind[] = Array.from({ length: slots }, () => 'none')
  const paint = (t: number, k: TickKind) => {
    const i = Math.floor((t - startMs) / MIN)
    if (i >= 0 && i < slots && RANK[k] > RANK[ticks[i]]) ticks[i] = k
  }
  for (const r of runs) paint(toMs(r.t), runKind(r))
  if (expectMissing) for (const t of missingTicks(runs, trigger, startMs, nowMs)) paint(t, 'missing')

  // A cooldown span bridges the idle minutes between its own evaluations.
  const gap = trigger.kind === 'tick' ? Math.max(1, trigger.everyMin) : 1
  const cooldowns: Array<[number, number]> = []
  let open: [number, number] | null = null
  for (let i = 0; i < slots; i++) {
    if (ticks[i] === 'cooldown') {
      if (open && i - open[1] <= gap) open[1] = i
      else {
        if (open) cooldowns.push(open)
        open = [i, i]
      }
    }
    else if (ticks[i] !== 'none' && open) {
      cooldowns.push(open)
      open = null
    }
  }
  if (open) cooldowns.push(open)
  return { startMs, endMs, ticks, cooldowns }
}

export type LogKind = Exclude<TickKind, 'none'>

export interface LogGroup {
  kind: LogKind
  reason: string | null
  count: number
  /** Oldest and newest member times (ms). */
  firstMs: number
  lastMs: number
  /** Live actions sent across the group. */
  sent: number
}

/** Today's evaluations plus inferred missing ticks, newest first, runs of identical results collapsed. */
export function groupLog(runs: EvalRun[], missing: number[]): LogGroup[] {
  const events = [
    ...runs.map(r => ({ t: toMs(r.t), kind: runKind(r) as LogKind, reason: r.reason, sent: r.sent })),
    ...missing.map(t => ({ t, kind: 'missing' as LogKind, reason: null, sent: false })),
  ].sort((a, b) => b.t - a.t)
  const out: LogGroup[] = []
  for (const e of events) {
    const g = out.at(-1)
    if (g && g.kind === e.kind && g.reason === e.reason) {
      g.count++
      g.firstMs = e.t
      if (e.sent) g.sent++
    }
    else {
      out.push({ kind: e.kind, reason: e.reason, count: 1, firstMs: e.t, lastMs: e.t, sent: e.sent ? 1 : 0 })
    }
  }
  return out
}

/** Filter chip buckets; cooldown and error count toward Skipped/All as the engine logs them. */
export type LogFilter = 'all' | 'would' | 'fired' | 'skipped' | 'missing'

export function filterOf(kind: LogKind): Exclude<LogFilter, 'all'> | null {
  if (kind === 'would' || kind === 'fired' || kind === 'missing') return kind
  if (kind === 'skipped' || kind === 'cooldown') return 'skipped'
  return null
}

/** Evaluation counts per filter chip (individual evaluations, not groups). */
export function filterCounts(groups: LogGroup[]): Record<LogFilter, number> {
  const out: Record<LogFilter, number> = { all: 0, would: 0, fired: 0, skipped: 0, missing: 0 }
  for (const g of groups) {
    out.all += g.count
    const f = filterOf(g.kind)
    if (f) out[f] += g.count
  }
  return out
}

/** "every minute", "every 5 min", "when ambient.temperature changes", "daily at 06:30". */
export function cadenceText(trigger: Trigger): string {
  if (trigger.kind === 'tick') return trigger.everyMin <= 1 ? 'every minute' : `every ${trigger.everyMin} min`
  if (trigger.kind === 'signalChange') return `on ${trigger.signal} change`
  return `daily at ${trigger.at}`
}

/** Condition verdict implied by the latest evaluation row. */
export function lastVerdict(run: EvalRun | undefined): 'true' | 'false' | 'unknown' | 'error' | null {
  if (!run) return null
  if (run.outcome === 'error') return 'error'
  if (run.outcome === 'skipped' && run.reason === 'condition-false') return 'false'
  if (run.outcome === 'skipped' && run.reason === 'condition-unknown') return 'unknown'
  return 'true'
}

export interface Threshold { signal: string, op: string, value: number, window?: { fn: string, lastMin: number } }

/** Compares of a signal/window against a literal — the thresholds a condition checks. */
export function thresholds(c: Condition): Threshold[] {
  const out: Threshold[] = []
  const walk = (x: Condition): void => {
    if (x.kind === 'and' || x.kind === 'or') x.conditions.forEach(walk)
    else if (x.kind === 'not') walk(x.condition)
    else if (x.kind === 'compare' && x.right.kind === 'literal') {
      const l: Expr = x.left
      if (l.kind === 'signal') out.push({ signal: l.signal, op: x.op, value: x.right.value })
      else if (l.kind === 'window') out.push({ signal: l.signal, op: x.op, value: x.right.value, window: { fn: l.fn, lastMin: l.lastMin } })
    }
  }
  walk(c)
  return out
}
