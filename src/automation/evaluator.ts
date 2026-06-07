/**
 * Condition (IF) evaluation with three-valued logic: true / false / undefined.
 *
 * `undefined` means "unknown" — an operand referenced a signal with no current
 * value. The engine treats unknown as a skip (never a fire), so a rule never
 * acts on missing data. AND short-circuits on a definite false; OR on a
 * definite true; an unknown child only matters when nothing else decides it.
 */

import type { CompareOp, Condition } from './types'
import { evaluateExpr, type EvalContext } from './expressions'

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
  switch (cond.kind) {
    case 'and': {
      let sawUnknown = false
      for (const c of cond.conditions) {
        const r = evaluateCondition(c, ctx)
        if (r === false) return false
        if (r === undefined) sawUnknown = true
      }
      return sawUnknown ? undefined : true
    }

    case 'or': {
      let sawUnknown = false
      for (const c of cond.conditions) {
        const r = evaluateCondition(c, ctx)
        if (r === true) return true
        if (r === undefined) sawUnknown = true
      }
      return sawUnknown ? undefined : false
    }

    case 'not': {
      const r = evaluateCondition(cond.condition, ctx)
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
  }
}
