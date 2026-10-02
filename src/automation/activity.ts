/**
 * Activity log — turns raw `automation_runs` rows into "why the bed changed, or
 * didn't" entries for the Automations page. Pure (no DB, no clock) so the
 * router and tests share it.
 *
 * Each run is classified into a display outcome plus a reason code; the client
 * formats codes into copy (it knows the user's unit and locale). Consecutive
 * skips of one rule with the same reason collapse into a single entry carrying
 * a time range and a count, so a rule idling outside its window all night is
 * one row, not 420.
 */

import type { Condition, RunOutcome, Side } from './types'

export type ReasonCode
  = | 'signal-unavailable'
    | 'outside-window'
    | 'condition-false'
    | 'cooldown'
    | 'manual-hold'
    | 'anti-thrash'
    | 'side-off'
    | 'superseded'
    | 'runaway'
    | 'eval-error'
    | 'action-error'
    | 'set-temperature'
    | 'notify'
    | 'power-on'
    | 'power-off'
    | 'unknown'

export interface RunRow {
  automationId: number
  firedAt: Date
  outcome: RunOutcome
  detail: unknown
}

export interface ClassifiedRun {
  ruleId: number
  at: number
  outcome: RunOutcome
  code: ReasonCode
  /** Resolved setpoint (°F) for temperature actions. */
  temp: number | null
  sides: Side[]
}

export interface ActivityEntry {
  ruleId: number
  outcome: RunOutcome
  code: ReasonCode
  /** First and last run in the entry, epoch ms (equal for a single run). */
  start: number
  end: number
  count: number
  temp: number | null
  sides: Side[]
}

interface ActionResultLike {
  kind?: string
  side?: Side
  sent?: boolean
  notified?: boolean
  dryRun?: boolean
  antiThrash?: boolean
  clamped?: boolean
  skipped?: string
  error?: string
  temp?: number
  on?: boolean
}

/** First `timeBetween` window in a condition tree (HH:MM strings), or null. */
export function conditionTimeWindow(c: Condition): { start: string, end: string } | null {
  switch (c.kind) {
    case 'timeBetween':
      return { start: c.start, end: c.end }
    case 'and':
    case 'or':
      for (const x of c.conditions) {
        const w = conditionTimeWindow(x)
        if (w) return w
      }
      return null
    case 'not':
      return null
    default:
      return null
  }
}

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Is a local minute-of-day inside an HH:MM window (wraps past midnight)? */
export function inTimeWindow(minuteOfDay: number, w: { start: string, end: string }): boolean {
  const s = toMin(w.start)
  const e = toMin(w.end)
  if (s === e) return false
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e
}

function actionsOf(detail: unknown): ActionResultLike[] {
  if (!detail || typeof detail !== 'object') return []
  const a = (detail as { actions?: unknown }).actions
  return Array.isArray(a) ? a.filter((x): x is ActionResultLike => !!x && typeof x === 'object') : []
}

function reasonOf(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object') return null
  const r = (detail as { reason?: unknown }).reason
  return typeof r === 'string' ? r : null
}

function uniqueSides(results: ActionResultLike[]): Side[] {
  const out: Side[] = []
  for (const r of results) if ((r.side === 'left' || r.side === 'right') && !out.includes(r.side)) out.push(r.side)
  return out
}

/**
 * Classify one run. `insideWindow` is whether the run's local time fell inside
 * the rule's time window (null when the rule has none) — it splits a false
 * condition into "outside 11 PM–6 AM" and a plain "condition not met".
 */
export function classifyRun(row: RunRow, insideWindow: boolean | null): ClassifiedRun {
  const base = { ruleId: row.automationId, at: row.firedAt.getTime(), temp: null as number | null, sides: [] as Side[] }
  const reason = reasonOf(row.detail)
  if (reason === 'condition-unknown') return { ...base, outcome: 'skipped', code: 'signal-unavailable' }
  if (reason === 'condition-false') return { ...base, outcome: 'skipped', code: insideWindow === false ? 'outside-window' : 'condition-false' }
  if (reason === 'cooldown') return { ...base, outcome: 'skipped', code: 'cooldown' }
  if (reason === 'runaway-disabled') return { ...base, outcome: 'error', code: 'runaway' }
  if (reason === 'eval-threw') return { ...base, outcome: 'error', code: 'eval-error' }

  const results = actionsOf(row.detail)
  const sides = uniqueSides(results)
  const temp = results.find(r => typeof r.temp === 'number')?.temp ?? null
  const withData = { ...base, sides, temp }

  if (row.outcome === 'error') return { ...withData, outcome: 'error', code: results.some(r => r.error) ? 'action-error' : 'unknown' }

  const acted = results.filter(r => r.notified || r.sent || r.dryRun)
  if (row.outcome === 'skipped' || acted.length === 0) {
    if (results.some(r => r.antiThrash)) return { ...withData, outcome: 'skipped', code: 'anti-thrash' }
    const skipped = results.find(r => r.skipped)?.skipped
    const code: ReasonCode = skipped === 'manual-hold'
      ? 'manual-hold'
      : skipped === 'temp-unknown'
        ? 'signal-unavailable'
        : skipped === 'off' || skipped === 'safety'
          ? 'side-off'
          : skipped
            ? 'superseded'
            : 'unknown'
    return { ...withData, outcome: 'skipped', code }
  }

  const first = acted[0]
  const code: ReasonCode = first.kind === 'notify'
    ? 'notify'
    : first.kind === 'setPower'
      ? (first.on === false ? 'power-off' : 'power-on')
      : 'set-temperature'
  return { ...withData, outcome: row.outcome, code }
}

/**
 * Collapse consecutive same-reason skips per rule, then order newest first.
 * Runs must be for one bucket (night); callers split before collapsing so a
 * range never straddles two nights.
 */
export function collapseRuns(runs: ClassifiedRun[]): ActivityEntry[] {
  const sorted = [...runs].sort((a, b) => a.at - b.at)
  const open = new Map<number, ActivityEntry>()
  const out: ActivityEntry[] = []
  for (const r of sorted) {
    const prev = open.get(r.ruleId)
    if (prev && r.outcome === 'skipped' && prev.outcome === 'skipped' && prev.code === r.code) {
      prev.end = r.at
      prev.count++
      for (const s of r.sides) if (!prev.sides.includes(s)) prev.sides.push(s)
      continue
    }
    const entry: ActivityEntry = { ruleId: r.ruleId, outcome: r.outcome, code: r.code, start: r.at, end: r.at, count: 1, temp: r.temp, sides: [...r.sides] }
    open.set(r.ruleId, entry)
    out.push(entry)
  }
  return out.sort((a, b) => b.end - a.end || b.start - a.start)
}

/** Split runs into buckets by ascending boundaries; runs before the first are dropped. */
export function bucketRuns<T extends { at: number }>(runs: T[], starts: number[], end: number): T[][] {
  const buckets: T[][] = starts.map(() => [])
  for (const r of runs) {
    if (r.at >= end) continue
    for (let i = starts.length - 1; i >= 0; i--) {
      if (r.at >= starts[i]) {
        buckets[i].push(r)
        break
      }
    }
  }
  return buckets
}
