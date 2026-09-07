/** Read-only presentation of a rule's primary numeric condition. */
import type { AutomationRule, Condition, Expr, CompareOp } from './types'
import type { EvalContext } from './expressions'
import { evaluateExpr } from './expressions'
import { evaluateCondition } from './evaluator'

export interface LiveReading {
  signal: string
  aggregation: string | null
  windowMin: number | null
  value: number | null
  op: CompareOp | null
  threshold: number | null
  matched: boolean | null
}

function comparison(c: Condition): Extract<Condition, { kind: 'compare' }> | undefined {
  if (c.kind === 'compare' && (c.left.kind === 'signal' || c.left.kind === 'window') && c.right.kind === 'literal') return c
  // OR and NOT cannot be represented by a single firing comparison.
  if (c.kind === 'and') return c.conditions.map(comparison).find(Boolean)
}

function signalExpr(e: Expr): Extract<Expr, { kind: 'signal' | 'window' }> | undefined {
  if (e.kind === 'signal' || e.kind === 'window') return e
  if (e.kind === 'binary') return signalExpr(e.left) ?? signalExpr(e.right)
  if (e.kind === 'clamp') return signalExpr(e.value)
}

/** Reuse evaluator/window semantics without sampling windows or executing actions. */
export function readRuleLive(rule: AutomationRule, ctx: EvalContext): LiveReading | null {
  const c = comparison(rule.conditions)
  let expr = c ? signalExpr(c.left) : undefined
  if (!expr && rule.trigger.kind === 'signalChange') expr = { kind: 'signal', signal: rule.trigger.signal }
  if (!expr) {
    for (const action of rule.actions) {
      if (action.kind !== 'notify' && action.temp) expr = signalExpr(action.temp)
      if (expr) break
    }
  }
  if (!expr) return null
  const value = evaluateExpr(expr, ctx)
  const finite = value !== undefined && Number.isFinite(value)
  return {
    signal: expr.signal,
    aggregation: expr.kind === 'window' ? expr.fn : null,
    windowMin: expr.kind === 'window' ? expr.lastMin : null,
    value: finite ? value : null,
    op: c?.op ?? null,
    threshold: c?.right.kind === 'literal' ? c.right.value : null,
    matched: c && finite ? evaluateCondition(c, ctx) ?? null : null,
  }
}
