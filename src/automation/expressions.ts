/**
 * Expression evaluation. Every expression resolves to a number, or `undefined`
 * when a referenced signal/window has no value — undefined propagates through
 * arithmetic so a condition built on missing data evaluates to "unknown" and
 * the rule skips rather than firing blind.
 */

import type { DayOfWeek, Expr } from './types'
import type { WindowStore } from './windows'

export interface EvalContext {
  /** Resolve a scalar signal key (e.g. `left.currentTemperature`) to a number. */
  signal: (key: string) => number | undefined
  /** Windowed-aggregate store, queried at `nowMs`. */
  windows: WindowStore
  nowMs: number
  /** Minutes since local midnight, timezone-aware. */
  nowMinutes: number
  dayOfWeek: DayOfWeek
  /** Local calendar date (yyyy-mm-dd) — keys once-per-day trigger state. */
  dateKey?: string
}

/** Clamp `value` to `[min, max]`. Bounds may be undefined (then ignored). */
export function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let out = value
  if (min !== undefined && out < min) out = min
  if (max !== undefined && out > max) out = max
  return out
}

export function evaluateExpr(expr: Expr, ctx: EvalContext): number | undefined {
  switch (expr.kind) {
    case 'literal':
      return expr.value

    case 'signal':
      return ctx.signal(expr.signal)

    case 'window':
      return ctx.windows.aggregate(expr.fn, expr.signal, expr.lastMin, ctx.nowMs)

    case 'binary': {
      const l = evaluateExpr(expr.left, ctx)
      const r = evaluateExpr(expr.right, ctx)
      if (l === undefined || r === undefined) return undefined
      switch (expr.op) {
        case '+':
          return l + r
        case '-':
          return l - r
        case '*':
          return l * r
        case '/':
          return r === 0 ? undefined : l / r
      }
      return undefined
    }

    case 'clamp': {
      const v = evaluateExpr(expr.value, ctx)
      if (v === undefined) return undefined
      const lo = evaluateExpr(expr.min, ctx)
      const hi = evaluateExpr(expr.max, ctx)
      return clamp(v, lo, hi)
    }
  }
}
