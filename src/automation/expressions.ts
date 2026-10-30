/**
 * Expression evaluation. Every expression resolves to a number, or `undefined`
 * when a referenced signal/window has no value — undefined propagates through
 * arithmetic so a condition built on missing data evaluates to "unknown" and
 * the rule skips rather than firing blind.
 */

import type { DayOfWeek, Expr } from './types'
import type { WindowStore } from './windows'
import { finiteSignal } from './signalValidity'

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
      return finiteSignal(expr.value)

    case 'signal':
      return finiteSignal(ctx.signal(expr.signal))

    case 'window':
      // History cannot keep a dependent rule active after its source disappears.
      if (finiteSignal(ctx.signal(expr.signal)) === undefined) return undefined
      return finiteSignal(ctx.windows.aggregate(expr.fn, expr.signal, expr.lastMin, ctx.nowMs))

    case 'binary': {
      const left = evaluateExpr(expr.left, ctx)
      const right = evaluateExpr(expr.right, ctx)
      if (left === undefined || right === undefined) return undefined
      switch (expr.op) {
        case '+':
          return finiteSignal(left + right)
        case '-':
          return finiteSignal(left - right)
        case '*':
          return finiteSignal(left * right)
        case '/':
          return right === 0 ? undefined : finiteSignal(left / right)
      }
      return undefined
    }

    case 'clamp': {
      const value = evaluateExpr(expr.value, ctx)
      const lower = evaluateExpr(expr.min, ctx)
      const upper = evaluateExpr(expr.max, ctx)
      if (value === undefined || lower === undefined || upper === undefined || lower > upper) return undefined
      return clamp(value, lower, upper)
    }
  }
}
