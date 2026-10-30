import { describe, expect, it } from 'vitest'
import { clamp, evaluateExpr, type EvalContext } from '../expressions'
import { WindowStore } from '../windows'
import type { Expr } from '../types'

function ctx(signals: Record<string, number | undefined>, windows = new WindowStore()): EvalContext {
  return {
    signal: k => signals[k],
    windows,
    nowMs: 0,
    nowMinutes: 0,
    dayOfWeek: 'monday',
  }
}

describe('clamp', () => {
  it('respects min and max, ignoring undefined bounds', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
    expect(clamp(11, undefined, 10)).toBe(10)
    expect(clamp(-5, 0, undefined)).toBe(0)
    expect(clamp(42, undefined, undefined)).toBe(42)
  })
})

describe('evaluateExpr', () => {
  it('resolves literals and signals', () => {
    const c = ctx({ 'ambient.temperature': 68 })
    expect(evaluateExpr({ kind: 'literal', value: 3 }, c)).toBe(3)
    expect(evaluateExpr({ kind: 'signal', signal: 'ambient.temperature' }, c)).toBe(68)
  })

  it('computes ambient + 3 (the continuous-policy expression)', () => {
    const c = ctx({ 'ambient.temperature': 68 })
    const expr: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'signal', signal: 'ambient.temperature' },
      right: { kind: 'literal', value: 3 },
    }
    expect(evaluateExpr(expr, c)).toBe(71)
  })

  it('propagates undefined through arithmetic when a signal is missing', () => {
    const c = ctx({})
    const expr: Expr = {
      kind: 'binary',
      op: '+',
      left: { kind: 'signal', signal: 'ambient.temperature' },
      right: { kind: 'literal', value: 3 },
    }
    expect(evaluateExpr(expr, c)).toBeUndefined()
  })

  it('computes subtraction and multiplication', () => {
    const c = ctx({ 'left.currentTemperature': 80 })
    const sub: Expr = { kind: 'binary', op: '-', left: { kind: 'signal', signal: 'left.currentTemperature' }, right: { kind: 'literal', value: 2 } }
    const mul: Expr = { kind: 'binary', op: '*', left: { kind: 'literal', value: 4 }, right: { kind: 'literal', value: 3 } }
    expect(evaluateExpr(sub, c)).toBe(78)
    expect(evaluateExpr(mul, c)).toBe(12)
  })

  it('treats divide-by-zero as undefined', () => {
    const c = ctx({})
    const expr: Expr = {
      kind: 'binary',
      op: '/',
      left: { kind: 'literal', value: 10 },
      right: { kind: 'literal', value: 0 },
    }
    expect(evaluateExpr(expr, c)).toBeUndefined()
  })

  it('divides when the denominator is non-zero', () => {
    const c = ctx({})
    const expr: Expr = { kind: 'binary', op: '/', left: { kind: 'literal', value: 10 }, right: { kind: 'literal', value: 4 } }
    expect(evaluateExpr(expr, c)).toBe(2.5)
  })

  it('returns undefined for an unrecognized binary operator', () => {
    const c = ctx({})
    const expr = { kind: 'binary', op: '%', left: { kind: 'literal', value: 10 }, right: { kind: 'literal', value: 4 } } as unknown as Expr
    expect(evaluateExpr(expr, c)).toBeUndefined()
  })

  it('evaluates clamp() expressions', () => {
    const c = ctx({})
    const expr: Expr = {
      kind: 'clamp',
      value: { kind: 'literal', value: 200 },
      min: { kind: 'literal', value: 60 },
      max: { kind: 'literal', value: 100 },
    }
    expect(evaluateExpr(expr, c)).toBe(100)
  })

  it('propagates undefined out of a clamp whose value is unavailable', () => {
    const c = ctx({})
    const expr: Expr = {
      kind: 'clamp',
      value: { kind: 'signal', signal: 'missing' },
      min: { kind: 'literal', value: 60 },
      max: { kind: 'literal', value: 100 },
    }
    expect(evaluateExpr(expr, c)).toBeUndefined()
  })

  it.each(['avg', 'min', 'max', 'sum', 'count'] as const)('withholds historical %s when the current source disappears', (fn) => {
    const windows = new WindowStore()
    windows.record('room', 80, 0)
    const expression: Expr = { kind: 'window', fn, signal: 'room', lastMin: 10 }
    expect(evaluateExpr(expression, ctx({}, windows))).toBeUndefined()
    expect(evaluateExpr(expression, ctx({ room: NaN }, windows))).toBeUndefined()
    expect(evaluateExpr(expression, ctx({ room: 80 }, windows))).toBe(fn === 'count' ? 1 : 80)
  })

  it.each([NaN, Infinity, -Infinity])('treats non-finite literals and signals (%s) as missing', (value) => {
    expect(evaluateExpr({ kind: 'literal', value }, ctx({}))).toBeUndefined()
    expect(evaluateExpr({ kind: 'signal', signal: 'room' }, ctx({ room: value }))).toBeUndefined()
  })

  it('withholds overflowing arithmetic and a missing or inverted clamp bound', () => {
    const overflow: Expr = { kind: 'binary', op: '*', left: { kind: 'literal', value: 1e308 }, right: { kind: 'literal', value: 2 } }
    expect(evaluateExpr(overflow, ctx({}))).toBeUndefined()
    const bounded: Expr = { kind: 'clamp', value: { kind: 'literal', value: 72 }, min: { kind: 'signal', signal: 'minimum' }, max: { kind: 'signal', signal: 'maximum' } }
    expect(evaluateExpr(bounded, ctx({ minimum: 70 }))).toBeUndefined()
    expect(evaluateExpr(bounded, ctx({ maximum: 90 }))).toBeUndefined()
    expect(evaluateExpr(bounded, ctx({ minimum: 90, maximum: 70 }))).toBeUndefined()
    expect(evaluateExpr(bounded, ctx({ minimum: 70, maximum: 90 }))).toBe(72)
  })

  it('invalid samples cannot poison later valid window aggregates', () => {
    const windows = new WindowStore()
    windows.record('room', Infinity, 0)
    windows.record('room', 80, NaN)
    windows.record('room', 70, 0)
    expect(evaluateExpr({ kind: 'window', fn: 'avg', signal: 'room', lastMin: 10 }, ctx({ room: 70 }, windows))).toBe(70)
  })

  it('reads windowed aggregates from the store', () => {
    const windows = new WindowStore()
    windows.record('left.movement', 300, 0)
    windows.record('left.movement', 100, 0)
    const c = { ...ctx({ 'left.movement': 100 }, windows), nowMs: 0 }
    expect(evaluateExpr({ kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, c)).toBe(200)
  })
})
