import { describe, expect, it } from 'vitest'
import { evaluateCondition } from '../evaluator'
import type { EvalContext } from '../expressions'
import { WindowStore } from '../windows'
import type { CompareOp, Condition, DayOfWeek } from '../types'

function ctx(opts: {
  signals?: Record<string, number | undefined>
  nowMinutes?: number
  dayOfWeek?: DayOfWeek
}): EvalContext {
  return {
    signal: k => (opts.signals ?? {})[k],
    windows: new WindowStore(),
    nowMs: 0,
    nowMinutes: opts.nowMinutes ?? 0,
    dayOfWeek: opts.dayOfWeek ?? 'monday',
  }
}

const cmp = (op: CompareOp, signal: string, value: number): Condition => ({
  kind: 'compare',
  op,
  left: { kind: 'signal', signal },
  right: { kind: 'literal', value },
})

describe('evaluateCondition — comparisons', () => {
  it('evaluates numeric comparisons', () => {
    const c = ctx({ signals: { x: 10 } })
    expect(evaluateCondition(cmp('>', 'x', 5), c)).toBe(true)
    expect(evaluateCondition(cmp('<', 'x', 5), c)).toBe(false)
    expect(evaluateCondition(cmp('>=', 'x', 10), c)).toBe(true)
    expect(evaluateCondition(cmp('<=', 'x', 10), c)).toBe(true)
    expect(evaluateCondition(cmp('==', 'x', 10), c)).toBe(true)
    expect(evaluateCondition(cmp('!=', 'x', 10), c)).toBe(false)
  })

  it('returns undefined when a signal is unavailable', () => {
    const c = ctx({ signals: {} })
    expect(evaluateCondition(cmp('>', 'x', 5), c)).toBeUndefined()
  })
})

describe('evaluateCondition — three-valued AND/OR/NOT', () => {
  it('AND short-circuits on a definite false, else unknown if any unknown', () => {
    const known = ctx({ signals: { a: 1, b: 1 } })
    expect(evaluateCondition({ kind: 'and', conditions: [cmp('>', 'a', 0), cmp('>', 'b', 0)] }, known)).toBe(true)

    const oneFalse = ctx({ signals: { a: 1 } }) // b missing
    // a>0 true, b>0 unknown → unknown
    expect(evaluateCondition({ kind: 'and', conditions: [cmp('>', 'a', 0), cmp('>', 'b', 0)] }, oneFalse)).toBeUndefined()
    // a<0 false dominates even with b unknown
    expect(evaluateCondition({ kind: 'and', conditions: [cmp('<', 'a', 0), cmp('>', 'b', 0)] }, oneFalse)).toBe(false)
  })

  it('OR short-circuits on a definite true, else unknown if any unknown', () => {
    const c = ctx({ signals: { a: 1 } }) // b missing
    expect(evaluateCondition({ kind: 'or', conditions: [cmp('>', 'a', 0), cmp('>', 'b', 0)] }, c)).toBe(true)
    expect(evaluateCondition({ kind: 'or', conditions: [cmp('<', 'a', 0), cmp('>', 'b', 0)] }, c)).toBeUndefined()
  })

  it('OR of all-definite-false members is false', () => {
    const c = ctx({ signals: { a: 1 } })
    expect(evaluateCondition({ kind: 'or', conditions: [cmp('<', 'a', 0), cmp('>', 'a', 5)] }, c)).toBe(false)
  })

  it('NOT inverts, preserving unknown', () => {
    const c = ctx({ signals: { a: 1 } })
    expect(evaluateCondition({ kind: 'not', condition: cmp('>', 'a', 0) }, c)).toBe(false)
    expect(evaluateCondition({ kind: 'not', condition: cmp('>', 'missing', 0) }, c)).toBeUndefined()
  })
})

describe('evaluateCondition — between/time/days', () => {
  it('evaluates between (inclusive)', () => {
    const c = ctx({ signals: { x: 5 } })
    const between: Condition = {
      kind: 'between',
      subject: { kind: 'signal', signal: 'x' },
      min: { kind: 'literal', value: 0 },
      max: { kind: 'literal', value: 10 },
    }
    expect(evaluateCondition(between, c)).toBe(true)
  })

  it('returns undefined for a between whose subject is unavailable', () => {
    const between: Condition = {
      kind: 'between',
      subject: { kind: 'signal', signal: 'missing' },
      min: { kind: 'literal', value: 0 },
      max: { kind: 'literal', value: 10 },
    }
    expect(evaluateCondition(between, ctx({ signals: {} }))).toBeUndefined()
  })

  it('handles a same-day time window (09:00–17:00)', () => {
    const win: Condition = { kind: 'timeBetween', start: '09:00', end: '17:00' }
    expect(evaluateCondition(win, ctx({ nowMinutes: 12 * 60 }))).toBe(true) // inside
    expect(evaluateCondition(win, ctx({ nowMinutes: 8 * 60 }))).toBe(false) // before start
    expect(evaluateCondition(win, ctx({ nowMinutes: 18 * 60 }))).toBe(false) // after end
  })

  it('treats a zero-width time window as always false', () => {
    const win: Condition = { kind: 'timeBetween', start: '09:00', end: '09:00' }
    expect(evaluateCondition(win, ctx({ nowMinutes: 9 * 60 }))).toBe(false)
  })

  it('handles a time window that wraps past midnight (23:00–06:00)', () => {
    const win: Condition = { kind: 'timeBetween', start: '23:00', end: '06:00' }
    expect(evaluateCondition(win, ctx({ nowMinutes: 23 * 60 + 30 }))).toBe(true) // 23:30
    expect(evaluateCondition(win, ctx({ nowMinutes: 2 * 60 }))).toBe(true) // 02:00
    expect(evaluateCondition(win, ctx({ nowMinutes: 12 * 60 }))).toBe(false) // 12:00
  })

  it('matches onDays', () => {
    const days: Condition = { kind: 'onDays', days: ['saturday', 'sunday'] }
    expect(evaluateCondition(days, ctx({ dayOfWeek: 'saturday' }))).toBe(true)
    expect(evaluateCondition(days, ctx({ dayOfWeek: 'monday' }))).toBe(false)
  })
})
