import { describe, expect, it } from 'vitest'
import { createConditionStateStore, evaluateCondition } from '../evaluator'
import type { EvalContext } from '../expressions'
import { WindowStore } from '../windows'
import type { CompareOp, Condition, DayOfWeek } from '../types'

function ctx(opts: {
  signals?: Record<string, number | undefined>
  nowMinutes?: number
  dayOfWeek?: DayOfWeek
  nowMs?: number
  condState?: EvalContext['condState']
}): EvalContext {
  return {
    signal: k => (opts.signals ?? {})[k],
    windows: new WindowStore(),
    nowMs: opts.nowMs ?? 0,
    nowMinutes: opts.nowMinutes ?? 0,
    dayOfWeek: opts.dayOfWeek ?? 'monday',
    condState: opts.condState,
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

describe('evaluateCondition — hysteresis latch', () => {
  // Rising: activate at >=70, deactivate at <=65; the 65–70 band is dead.
  const hyst: Condition = { kind: 'hysteresis', subject: { kind: 'signal', signal: 'x' }, on: 70, off: 65 }

  it('latches on rising past `on` and off only below `off`, holding in the dead-band', () => {
    const store = createConditionStateStore()
    const at = (x: number): boolean | undefined => evaluateCondition(hyst, ctx({ signals: { x }, condState: store }))
    expect(at(60)).toBe(false) // below both
    expect(at(68)).toBe(false) // in dead-band, not yet activated
    expect(at(72)).toBe(true) // crosses `on`
    expect(at(67)).toBe(true) // dead-band, latch holds
    expect(at(66)).toBe(true) // still above `off`
    expect(at(64)).toBe(false) // drops to/below `off`
    expect(at(68)).toBe(false) // dead-band again, stays off until `on`
  })

  it('supports an inverted (falling) latch when on < off', () => {
    // Activate when x drops to <=40, deactivate when it rises to >=50.
    const low: Condition = { kind: 'hysteresis', subject: { kind: 'signal', signal: 'x' }, on: 40, off: 50 }
    const store = createConditionStateStore()
    const at = (x: number): boolean | undefined => evaluateCondition(low, ctx({ signals: { x }, condState: store }))
    expect(at(60)).toBe(false)
    expect(at(45)).toBe(false) // dead-band
    expect(at(38)).toBe(true) // crosses `on` downward
    expect(at(45)).toBe(true) // dead-band, latch holds
    expect(at(55)).toBe(false) // rises past `off`
  })

  it('holds the latch when the subject reads unknown', () => {
    const store = createConditionStateStore()
    expect(evaluateCondition(hyst, ctx({ signals: { x: 72 }, condState: store }))).toBe(true)
    expect(evaluateCondition(hyst, ctx({ signals: {}, condState: store }))).toBe(true) // missing → hold
  })

  it('is unknown when the subject is unavailable with no prior state', () => {
    expect(evaluateCondition(hyst, ctx({ signals: {}, condState: createConditionStateStore() }))).toBeUndefined()
  })

  it('reads instantaneously (no latch) without a state store', () => {
    expect(evaluateCondition(hyst, ctx({ signals: { x: 72 } }))).toBe(true)
    expect(evaluateCondition(hyst, ctx({ signals: { x: 67 } }))).toBe(false) // dead-band reads as off
  })
})

describe('evaluateCondition — sustained debounce', () => {
  const inner: Condition = { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'x' }, right: { kind: 'literal', value: 100 } }
  const sustained: Condition = { kind: 'sustained', condition: inner, forMin: 10 }

  it('fires only after the inner condition holds true for the full window', () => {
    const store = createConditionStateStore()
    const at = (x: number, min: number): boolean | undefined =>
      evaluateCondition(sustained, ctx({ signals: { x }, nowMs: min * 60_000, condState: store }))
    expect(at(150, 0)).toBe(false) // streak starts at t=0
    expect(at(150, 5)).toBe(false) // 5 min in, not enough
    expect(at(150, 10)).toBe(true) // 10 min sustained
    expect(at(150, 11)).toBe(true) // stays true while held
  })

  it('resets the streak on a false tick', () => {
    const store = createConditionStateStore()
    const at = (x: number, min: number): boolean | undefined =>
      evaluateCondition(sustained, ctx({ signals: { x }, nowMs: min * 60_000, condState: store }))
    expect(at(150, 0)).toBe(false)
    expect(at(50, 5)).toBe(false) // breaks the streak
    expect(at(150, 12)).toBe(false) // streak restarts at t=12
    expect(at(150, 21)).toBe(false) // only 9 min in
    expect(at(150, 22)).toBe(true) // 10 min from the restart
  })

  it('propagates unknown and resets when the inner condition is unknown', () => {
    const store = createConditionStateStore()
    expect(evaluateCondition(sustained, ctx({ signals: { x: 150 }, nowMs: 0, condState: store }))).toBe(false)
    expect(evaluateCondition(sustained, ctx({ signals: {}, nowMs: 5 * 60_000, condState: store }))).toBeUndefined()
    // streak reset → a fresh true does not immediately satisfy the window
    expect(evaluateCondition(sustained, ctx({ signals: { x: 150 }, nowMs: 12 * 60_000, condState: store }))).toBe(false)
  })

  it('never fires without a state store (cannot measure duration)', () => {
    expect(evaluateCondition(sustained, ctx({ signals: { x: 150 }, nowMs: 0 }))).toBe(false)
  })
})
