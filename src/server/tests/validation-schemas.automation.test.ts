import { describe, expect, it } from 'vitest'
import {
  automationActionSchema,
  automationConditionSchema,
  automationCreateSchema,
  automationExprSchema,
  automationTriggerSchema,
  automationUpdateSchema,
  validateDateRange,
} from '../validation-schemas'
import type { Condition, Expr } from '@/src/automation/types'

const sig = (signal: string): Expr => ({ kind: 'signal', signal })
const lit = (value: number): Expr => ({ kind: 'literal', value })

describe('automationExprSchema', () => {
  it('accepts each expression node kind', () => {
    expect(automationExprSchema.safeParse(lit(72)).success).toBe(true)
    expect(automationExprSchema.safeParse(sig('left.movement')).success).toBe(true)
    expect(automationExprSchema.safeParse({ kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }).success).toBe(true)
    expect(automationExprSchema.safeParse({ kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }).success).toBe(true)
    expect(automationExprSchema.safeParse({ kind: 'clamp', value: lit(72), min: lit(60), max: lit(75) }).success).toBe(true)
  })

  it('rejects a non-dotted signal key and an unknown kind', () => {
    expect(automationExprSchema.safeParse({ kind: 'signal', signal: 'bad key!' }).success).toBe(false)
    expect(automationExprSchema.safeParse({ kind: 'nope' }).success).toBe(false)
  })

  it('bounds the window lastMin to 1..1440', () => {
    expect(automationExprSchema.safeParse({ kind: 'window', fn: 'sum', signal: 'left.hrv', lastMin: 0 }).success).toBe(false)
    expect(automationExprSchema.safeParse({ kind: 'window', fn: 'sum', signal: 'left.hrv', lastMin: 1441 }).success).toBe(false)
  })

  it('rejects unknown extra keys (strict)', () => {
    expect(automationExprSchema.safeParse({ kind: 'literal', value: 1, extra: true }).success).toBe(false)
  })
})

describe('automationConditionSchema', () => {
  it('accepts a nested boolean tree', () => {
    const cond: Condition = {
      kind: 'and',
      conditions: [
        { kind: 'or', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(200) }] },
        { kind: 'not', condition: { kind: 'timeBetween', start: '23:00', end: '06:00' } },
        { kind: 'between', subject: sig('left.hrv'), min: lit(0), max: lit(100) },
        { kind: 'onDays', days: ['saturday', 'sunday'] },
      ],
    }
    expect(automationConditionSchema.safeParse(cond).success).toBe(true)
  })

  it('rejects a bad time string and an empty onDays list', () => {
    expect(automationConditionSchema.safeParse({ kind: 'timeBetween', start: '24:00', end: '06:00' }).success).toBe(false)
    expect(automationConditionSchema.safeParse({ kind: 'onDays', days: [] }).success).toBe(false)
  })

  it('caps a boolean group at 24 children', () => {
    const many = Array.from({ length: 25 }, () => ({ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(1) }))
    expect(automationConditionSchema.safeParse({ kind: 'and', conditions: many }).success).toBe(false)
  })
})

describe('automationTriggerSchema', () => {
  it('accepts tick / signalChange / timeOfDay', () => {
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1 }).success).toBe(true)
    expect(automationTriggerSchema.safeParse({ kind: 'signalChange', signal: 'water.low' }).success).toBe(true)
    expect(automationTriggerSchema.safeParse({ kind: 'timeOfDay', at: '23:00', days: ['monday'] }).success).toBe(true)
  })

  it('rejects an out-of-range tick interval', () => {
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 0 }).success).toBe(false)
    expect(automationTriggerSchema.safeParse({ kind: 'tick', everyMin: 1441 }).success).toBe(false)
  })
})

describe('automationActionSchema', () => {
  it('accepts notify / setTemperature / setPower', () => {
    expect(automationActionSchema.safeParse({ kind: 'notify', message: 'hi' }).success).toBe(true)
    expect(automationActionSchema.safeParse({ kind: 'setTemperature', temp: lit(72), clamp: { min: 60, max: 75 } }).success).toBe(true)
    expect(automationActionSchema.safeParse({ kind: 'setPower', on: true, temp: lit(72) }).success).toBe(true)
  })

  it('rejects an empty notify message and an over-long one', () => {
    expect(automationActionSchema.safeParse({ kind: 'notify', message: '' }).success).toBe(false)
    expect(automationActionSchema.safeParse({ kind: 'notify', message: 'x'.repeat(281) }).success).toBe(false)
  })

  it('rejects a clamp whose min exceeds max', () => {
    expect(automationActionSchema.safeParse({ kind: 'setTemperature', temp: lit(72), clamp: { min: 80, max: 70 } }).success).toBe(false)
  })
})

describe('automationCreateSchema', () => {
  const base = {
    name: 'Restless cool-down',
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: lit(200) }] },
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '-', left: sig('left.currentTemperature'), right: lit(2) }, clamp: { min: 60, max: 75 } }],
  }

  it('parses a valid rule and applies defaults', () => {
    const parsed = automationCreateSchema.parse(base)
    expect(parsed.enabled).toBe(true)
    expect(parsed.dryRun).toBe(true)
    expect(parsed.side).toBeNull()
    expect(parsed.priority).toBe(0)
    expect(parsed.cooldownMin).toBeNull()
  })

  it('requires at least one action and caps at ten', () => {
    expect(automationCreateSchema.safeParse({ ...base, actions: [] }).success).toBe(false)
    const eleven = Array.from({ length: 11 }, () => ({ kind: 'notify', message: 'x' }))
    expect(automationCreateSchema.safeParse({ ...base, actions: eleven }).success).toBe(false)
  })

  it('rejects an AST that exceeds the node budget', () => {
    // Build a left-leaning binary chain well past AUTOMATION_MAX_AST_NODES (400).
    let temp: Expr = sig('left.currentTemperature')
    for (let i = 0; i < 250; i++) temp = { kind: 'binary', op: '+', left: temp, right: lit(1) }
    const res = automationCreateSchema.safeParse({ ...base, actions: [{ kind: 'setTemperature', temp, clamp: { min: 60, max: 75 } }] })
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error.issues.some(i => i.message.includes('too large'))).toBe(true)
  })

  it('measures clamp expressions and between conditions when enforcing bounds', () => {
    const res = automationCreateSchema.safeParse({
      ...base,
      conditions: {
        kind: 'and',
        conditions: [
          { kind: 'between', subject: sig('left.hrv'), min: lit(0), max: lit(100) },
          { kind: 'timeBetween', start: '23:00', end: '06:00' },
        ],
      },
      actions: [{
        kind: 'setTemperature',
        temp: { kind: 'clamp', value: { kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }, min: lit(60), max: lit(75) },
        clamp: { min: 60, max: 75 },
      }],
    })
    expect(res.success).toBe(true)
  })

  it('rejects an AST that exceeds the depth budget', () => {
    // A deep but small-node nested NOT chain trips depth (16) before nodes (400).
    let cond: Condition = { kind: 'compare', op: '>', left: sig('left.movement'), right: lit(1) }
    for (let i = 0; i < 20; i++) cond = { kind: 'not', condition: cond }
    const res = automationCreateSchema.safeParse({ ...base, conditions: cond })
    expect(res.success).toBe(false)
    if (!res.success) expect(res.error.issues.some(i => i.message.includes('too deep'))).toBe(true)
  })
})

describe('automationUpdateSchema', () => {
  it('requires an id and accepts a partial payload', () => {
    expect(automationUpdateSchema.safeParse({ name: 'rename' }).success).toBe(false) // no id
    expect(automationUpdateSchema.safeParse({ id: 5, enabled: false }).success).toBe(true)
  })

  it('still enforces AST bounds on the partial actions/conditions', () => {
    let temp: Expr = sig('left.currentTemperature')
    for (let i = 0; i < 250; i++) temp = { kind: 'binary', op: '+', left: temp, right: lit(1) }
    expect(automationUpdateSchema.safeParse({ id: 5, actions: [{ kind: 'setTemperature', temp, clamp: { min: 60, max: 75 } }] }).success).toBe(false)
  })
})

// ============================================================================
// AST bound measurement (measureExpr / measureCondition / enforceAstBounds)
//
// These exercise the recursive size/depth walk directly at its budget edges.
// The walk is only observable through the superRefine on the create/update
// schemas, so every case below is phrased as "this payload is (not) accepted".
//
// Fixtures are sized against the real budgets — depth 16, nodes 400 — so an
// off-by-one in either the accumulator (`depth + 1`, `+= nodes`) or the
// comparison (`>` vs `>=`) flips the outcome. `automationUpdateSchema` is used
// for the exact-count cases because it is fully partial: supplying only
// `conditions` or only `actions` keeps the other side from contributing nodes.
// ============================================================================

const AST_MAX_DEPTH = 16
const AST_MAX_NODES = 400

/** `n` binary nodes nested through the LEFT operand; depth grows via `e.left`. */
function leftChain(n: number): Expr {
  let e: Expr = lit(1)
  for (let i = 0; i < n; i++) e = { kind: 'binary', op: '+', left: e, right: lit(1) }
  return e
}

/** `n` binary nodes nested through the RIGHT operand; depth grows via `e.right`. */
function rightChain(n: number): Expr {
  let e: Expr = lit(1)
  for (let i = 0; i < n; i++) e = { kind: 'binary', op: '+', left: lit(1), right: e }
  return e
}

/**
 * A binary tree with exactly `n` nodes (n odd) and near-minimal depth, so node
 * budget can be tripped without also tripping the depth budget. 399 nodes lands
 * at 8 levels of `binary`, far inside the depth-16 cap.
 */
function balancedExpr(n: number): Expr {
  if (n <= 1) return lit(1)
  const rem = n - 1
  let leftN = Math.floor(rem / 2)
  if (leftN % 2 === 0) leftN += 1
  return { kind: 'binary', op: '+', left: balancedExpr(leftN), right: balancedExpr(rem - leftN) }
}

/** Independent node count, so the fixtures above are pinned rather than assumed. */
function countNodes(e: Expr): number {
  if (e.kind === 'binary') return 1 + countNodes(e.left) + countNodes(e.right)
  if (e.kind === 'clamp') return 1 + countNodes(e.value) + countNodes(e.min) + countNodes(e.max)
  return 1
}

function nestNot(n: number, inner: Condition): Condition {
  let c = inner
  for (let i = 0; i < n; i++) c = { kind: 'not', condition: c }
  return c
}

function nestGroup(n: number, kind: 'and' | 'or', inner: Condition): Condition {
  let c = inner
  for (let i = 0; i < n; i++) c = { kind, conditions: [c] }
  return c
}

const cmp = (left: Expr, right: Expr): Condition => ({ kind: 'compare', op: '>', left, right })
const tempAction = (temp: Expr) => ({ kind: 'setTemperature', temp })

const parseConditions = (conditions: Condition) => automationUpdateSchema.safeParse({ id: 1, conditions })
const parseActions = (...temps: Expr[]) => automationUpdateSchema.safeParse({ id: 1, actions: temps.map(tempAction) })

function expectRejected(res: { success: boolean, error?: { issues: { message: string }[] } }, fragment: string) {
  expect(res.success).toBe(false)
  expect(res.error?.issues.some(i => i.message.includes(fragment)) ?? false).toBe(true)
}

describe('AST bound fixtures', () => {
  it('builds the exact node counts the boundary cases depend on', () => {
    expect(countNodes(balancedExpr(399))).toBe(399)
    expect(countNodes(balancedExpr(1))).toBe(1)
    expect(countNodes(leftChain(16))).toBe(33)
    expect(countNodes(rightChain(16))).toBe(33)
  })
})

describe('enforceAstBounds — budget comparisons', () => {
  // `depth > 16` must stay strict: a rule sitting exactly on the cap is legal.
  // 14 nested NOTs put the compare's operands at depth 16 exactly.
  it('accepts a rule whose depth is exactly at the cap', () => {
    const res = parseConditions(nestNot(AST_MAX_DEPTH - 2, cmp(sig('left.movement'), lit(1))))
    expect(res.success).toBe(true)
  })

  it('rejects a rule one level past the depth cap', () => {
    expectRejected(parseConditions(nestNot(AST_MAX_DEPTH - 1, cmp(sig('left.movement'), lit(1)))), 'too deep')
  })

  // `nodes > 400` must stay strict: 399 + 1 across two actions is exactly 400.
  it('accepts a rule whose node count is exactly at the cap', () => {
    const res = parseActions(balancedExpr(AST_MAX_NODES - 1), lit(1))
    expect(res.success).toBe(true)
  })

  it('rejects a rule one node past the cap', () => {
    expectRejected(parseActions(balancedExpr(AST_MAX_NODES - 1), lit(1), lit(1)), 'too large')
  })
})

describe('measureExpr — depth accumulation', () => {
  // Each case drives the deep path through one specific `depth + 1` call site
  // and lands on depth 17, so decrementing instead of incrementing yields 15
  // (inside the cap) and the payload would wrongly be accepted.
  it('counts depth through a binary left operand', () => {
    expectRejected(parseActions(leftChain(AST_MAX_DEPTH)), 'too deep')
  })

  it('counts depth through a binary right operand', () => {
    expectRejected(parseActions(rightChain(AST_MAX_DEPTH)), 'too deep')
  })

  it('counts depth through a clamp value operand', () => {
    expectRejected(parseActions({ kind: 'clamp', value: leftChain(15), min: lit(1), max: lit(2) }), 'too deep')
  })

  it('counts depth through a clamp min operand', () => {
    expectRejected(parseActions({ kind: 'clamp', value: lit(1), min: leftChain(15), max: lit(2) }), 'too deep')
  })

  it('counts depth through a clamp max operand', () => {
    expectRejected(parseActions({ kind: 'clamp', value: lit(1), min: lit(2), max: leftChain(15) }), 'too deep')
  })

  // Only one clamp operand is deep, so taking the min across operands instead
  // of the max would report depth 2 and let this through.
  it('takes the deepest clamp operand rather than the shallowest', () => {
    const res = parseActions({ kind: 'clamp', value: leftChain(15), min: lit(1), max: lit(2) })
    expect(res.success).toBe(false)
  })
})

describe('measureExpr — node accumulation', () => {
  // 1 + 399 + 1 + 1 = 402 nodes at depth ~10: over the node cap, well under the
  // depth cap, so any sign flip in the sum drops it back inside the budget.
  it('sums every clamp operand into the node count', () => {
    expectRejected(parseActions({ kind: 'clamp', value: balancedExpr(399), min: lit(1), max: lit(2) }), 'too large')
  })

  it('sums both binary operands into the node count', () => {
    expectRejected(parseActions({ kind: 'binary', op: '+', left: balancedExpr(399), right: balancedExpr(3) }), 'too large')
  })
})

describe('measureCondition — depth accumulation', () => {
  it('counts depth through and-group children', () => {
    expectRejected(parseConditions(nestGroup(15, 'and', cmp(sig('left.movement'), lit(1)))), 'too deep')
  })

  it('counts depth through or-group children', () => {
    expectRejected(parseConditions(nestGroup(15, 'or', cmp(sig('left.movement'), lit(1)))), 'too deep')
  })

  it('counts depth through a compare left operand', () => {
    expectRejected(parseConditions(cmp(leftChain(15), lit(1))), 'too deep')
  })

  it('counts depth through a compare right operand', () => {
    expectRejected(parseConditions(cmp(lit(1), leftChain(15))), 'too deep')
  })

  it('counts depth through a between subject', () => {
    expectRejected(parseConditions({ kind: 'between', subject: leftChain(15), min: lit(1), max: lit(2) }), 'too deep')
  })

  it('counts depth through a between min operand', () => {
    expectRejected(parseConditions({ kind: 'between', subject: lit(1), min: leftChain(15), max: lit(2) }), 'too deep')
  })

  it('counts depth through a between max operand', () => {
    expectRejected(parseConditions({ kind: 'between', subject: lit(1), min: lit(2), max: leftChain(15) }), 'too deep')
  })
})

describe('measureCondition — node accumulation', () => {
  it('accumulates child nodes across a boolean group', () => {
    expectRejected(parseConditions({ kind: 'and', conditions: [cmp(balancedExpr(399), lit(1))] }), 'too large')
  })

  it('accumulates the negated child through a not', () => {
    expectRejected(parseConditions(nestNot(1, cmp(balancedExpr(399), lit(1)))), 'too large')
  })

  it('sums both compare operands into the node count', () => {
    expectRejected(parseConditions(cmp(balancedExpr(399), lit(1))), 'too large')
  })

  it('sums every between operand into the node count', () => {
    expectRejected(parseConditions({ kind: 'between', subject: balancedExpr(399), min: lit(1), max: lit(2) }), 'too large')
  })
})

describe('validateDateRange', () => {
  it('treats an identical start and end as a valid range', () => {
    const same = new Date('2026-07-20T00:00:00.000Z')
    expect(validateDateRange(same, new Date(same))).toBe(true)
  })

  it('accepts an ascending range and rejects a descending one', () => {
    const start = new Date('2026-07-20T00:00:00.000Z')
    const end = new Date('2026-07-21T00:00:00.000Z')
    expect(validateDateRange(start, end)).toBe(true)
    expect(validateDateRange(end, start)).toBe(false)
  })
})

describe('automationClampSchema band', () => {
  it('accepts a clamp whose min equals its max', () => {
    expect(automationActionSchema.safeParse({ kind: 'setTemperature', temp: lit(72), clamp: { min: 70, max: 70 } }).success).toBe(true)
  })
})
