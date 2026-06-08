/**
 * Condition (IF) evaluation with three-valued logic: true / false / undefined.
 *
 * `undefined` means "unknown" — an operand referenced a signal with no current
 * value. The engine treats unknown as a skip (never a fire), so a rule never
 * acts on missing data. AND short-circuits on a definite false; OR on a
 * definite true; an unknown child only matters when nothing else decides it.
 *
 * Two node kinds are stateful — `hysteresis` (a latch) and `sustained` (a
 * debounce). Their state lives in the optional `ctx.condState` store, keyed by
 * each node's position in the tree so it survives across ticks/steps. Callers
 * that evaluate a rule repeatedly (the engine, the backtest) pass a persistent
 * store; a one-shot caller omits it and those nodes read instantaneously.
 */

import type { CompareOp, Condition } from './types'
import { evaluateExpr, type EvalContext } from './expressions'

/** Persisted state for a stateful condition node, keyed by its tree path. */
export type ConditionNodeState
  = | { kind: 'hysteresis', active: boolean }
    | { kind: 'sustained', since: number | null }

export interface ConditionStateStore {
  get: (key: string) => ConditionNodeState | undefined
  set: (key: string, state: ConditionNodeState) => void
}

/** Wrap a Map (or a fresh one) as a ConditionStateStore. */
export function createConditionStateStore(
  map: Map<string, ConditionNodeState> = new Map(),
): ConditionStateStore {
  return { get: k => map.get(k), set: (k, s) => void map.set(k, s) }
}

function compare(op: CompareOp, l: number, r: number): boolean {
  switch (op) {
    case '>':
      return l > r
    case '>=':
      return l >= r
    case '<':
      return l < r
    case '<=':
      return l <= r
    case '==':
      return l === r
    case '!=':
      return l !== r
  }
}

/** Parse "HH:MM" to minutes since midnight. */
function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** Inclusive-start, exclusive-end window that may wrap past midnight. */
function inTimeWindow(nowMin: number, start: string, end: string): boolean {
  const s = toMinutes(start)
  const e = toMinutes(end)
  if (s === e) return false
  if (s < e) return nowMin >= s && nowMin < e
  // wraps midnight, e.g. 23:00–06:00
  return nowMin >= s || nowMin < e
}

export function evaluateCondition(cond: Condition, ctx: EvalContext): boolean | undefined {
  return evalCond(cond, ctx, 'r')
}

/**
 * Recursive core. `path` is a deterministic key for this node's position in the
 * tree — stable across ticks for a given rule — used to address the stateful
 * `hysteresis`/`sustained` nodes in `ctx.condState`.
 */
function evalCond(cond: Condition, ctx: EvalContext, path: string): boolean | undefined {
  switch (cond.kind) {
    case 'and': {
      let sawUnknown = false
      for (let i = 0; i < cond.conditions.length; i++) {
        const r = evalCond(cond.conditions[i], ctx, `${path}.${i}`)
        if (r === false) return false
        if (r === undefined) sawUnknown = true
      }
      return sawUnknown ? undefined : true
    }

    case 'or': {
      let sawUnknown = false
      for (let i = 0; i < cond.conditions.length; i++) {
        const r = evalCond(cond.conditions[i], ctx, `${path}.${i}`)
        if (r === true) return true
        if (r === undefined) sawUnknown = true
      }
      return sawUnknown ? undefined : false
    }

    case 'not': {
      const r = evalCond(cond.condition, ctx, `${path}.n`)
      return r === undefined ? undefined : !r
    }

    case 'compare': {
      const l = evaluateExpr(cond.left, ctx)
      const r = evaluateExpr(cond.right, ctx)
      if (l === undefined || r === undefined) return undefined
      return compare(cond.op, l, r)
    }

    case 'between': {
      const v = evaluateExpr(cond.subject, ctx)
      const lo = evaluateExpr(cond.min, ctx)
      const hi = evaluateExpr(cond.max, ctx)
      if (v === undefined || lo === undefined || hi === undefined) return undefined
      return v >= lo && v <= hi
    }

    case 'timeBetween':
      return inTimeWindow(ctx.nowMinutes, cond.start, cond.end)

    case 'onDays':
      return cond.days.includes(ctx.dayOfWeek)

    case 'hysteresis':
      return evalHysteresis(cond, ctx, path)

    case 'sustained':
      return evalSustained(cond, ctx, path)
  }
}

/** Latching threshold — see the `hysteresis` doc in types.ts for the model. */
function evalHysteresis(
  cond: Extract<Condition, { kind: 'hysteresis' }>,
  ctx: EvalContext,
  path: string,
): boolean | undefined {
  const prev = ctx.condState?.get(path)
  const wasActive = prev?.kind === 'hysteresis' ? prev.active : false

  const v = evaluateExpr(cond.subject, ctx)
  if (v === undefined) {
    // No reading this tick: hold the latch if we have one, else "unknown".
    return prev?.kind === 'hysteresis' ? prev.active : undefined
  }

  const rising = cond.on >= cond.off
  let active = wasActive
  if (rising) {
    if (!active && v >= cond.on) active = true
    else if (active && v <= cond.off) active = false
  }
  else {
    if (!active && v <= cond.on) active = true
    else if (active && v >= cond.off) active = false
  }
  ctx.condState?.set(path, { kind: 'hysteresis', active })
  return active
}

/** Sustained-for-N-min debounce — see the `sustained` doc in types.ts. */
function evalSustained(
  cond: Extract<Condition, { kind: 'sustained' }>,
  ctx: EvalContext,
  path: string,
): boolean | undefined {
  const inner = evalCond(cond.condition, ctx, `${path}.s`)
  if (inner !== true) {
    // Streak broken by a definite false or an unknown — reset and propagate.
    ctx.condState?.set(path, { kind: 'sustained', since: null })
    return inner === undefined ? undefined : false
  }
  // Stateless caller: we can't measure elapsed time, so it is never sustained.
  if (!ctx.condState) return false

  const prev = ctx.condState.get(path)
  const since = (prev?.kind === 'sustained' && prev.since !== null) ? prev.since : ctx.nowMs
  ctx.condState.set(path, { kind: 'sustained', since })
  return ctx.nowMs - since >= cond.forMin * 60_000
}
