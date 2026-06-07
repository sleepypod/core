import { describe, expect, it } from 'vitest'
import { type BacktestRule, runBacktest, type Sample } from '../backtest'
import type { Action, Condition, Trigger } from '../types'

const HOUR = 60 * 60_000

/** Per-minute movement samples: low, then a sustained burst, then low. */
function movementSeries(): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i < 60; i++) {
    const v = i >= 10 && i <= 40 ? 300 : 100
    out.push({ t: i * 60_000, v })
  }
  return out
}

function ambientSeries(value: number): Sample[] {
  const out: Sample[] = []
  for (let i = 0; i < 60; i++) out.push({ t: i * 60_000, v: value })
  return out
}

describe('runBacktest — edge-triggered (movement avg > 200 → lower 2°F)', () => {
  const rule: BacktestRule = {
    side: 'left',
    cooldownMin: 30,
    trigger: { kind: 'tick', everyMin: 1 } as Trigger,
    conditions: {
      kind: 'and',
      conditions: [{
        kind: 'compare',
        op: '>',
        left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 },
        right: { kind: 'literal', value: 200 },
      }],
    } as Condition,
    actions: [{
      kind: 'setTemperature',
      temp: { kind: 'binary', op: '-', left: { kind: 'signal', signal: 'left.currentTemperature' }, right: { kind: 'literal', value: 2 } },
      clamp: { min: 60, max: 75 },
      durationSec: 1200,
    }] as Action[],
  }

  const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })

  it('classifies as edge mode with the right threshold + primary trace', () => {
    expect(r.mode).toBe('edge')
    expect(r.threshold).toBe(200)
    expect(r.primary?.key).toBe('left.movement')
    expect(r.avg?.key).toBe('left.movement')
  })
  it('fires once then suppresses repeats during the cooldown window', () => {
    expect(r.fires.length).toBeGreaterThanOrEqual(1)
    expect(r.fires.length).toBeLessThanOrEqual(2)
    expect(r.suppressed.length).toBeGreaterThan(0)
  })
  it('reports the net effect of the action', () => {
    expect(r.summary.netEffect).toContain('-2°F')
  })
})

describe('runBacktest — continuous policy (ambient + 3, clamped)', () => {
  const policyRule = (): BacktestRule => ({
    side: null,
    cooldownMin: null,
    trigger: { kind: 'tick', everyMin: 1 } as Trigger,
    conditions: { kind: 'and', conditions: [] } as Condition,
    actions: [{
      kind: 'setTemperature',
      temp: { kind: 'binary', op: '+', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 3 } },
      clamp: { min: 60, max: 75 },
    }] as Action[],
  })

  it('tracks ambient + 3 and never fires discrete events', () => {
    const r = runBacktest({ rule: policyRule(), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(70) } })
    expect(r.mode).toBe('policy')
    expect(r.fires.length).toBe(0)
    const sample = r.setpoint.find(v => v != null)
    expect(sample).toBe(73)
    expect(r.summary.clampHits).toBe(0)
  })

  it('clamps the setpoint and counts the clamp hits when the expr exceeds the band', () => {
    const r = runBacktest({ rule: policyRule(), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(74) } })
    // 74 + 3 = 77, clamped to the 75 ceiling.
    const sample = r.setpoint.find(v => v != null)
    expect(sample).toBe(75)
    expect(r.summary.clampHits).toBeGreaterThan(0)
  })
})

const lit = (value: number) => ({ kind: 'literal' as const, value })
const sig = (signal: string) => ({ kind: 'signal' as const, signal })
const tick: Trigger = { kind: 'tick', everyMin: 1 }
const vacuous: Condition = { kind: 'and', conditions: [] }

describe('runBacktest — no setTemperature action', () => {
  it('leaves the setpoint series null when the rule only notifies', () => {
    const rule: BacktestRule = {
      side: 'left',
      cooldownMin: null,
      trigger: tick,
      conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(50) }] } as Condition,
      actions: [{ kind: 'notify', message: 'restless' }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })
    expect(r.mode).toBe('edge')
    expect(r.setpoint.every(v => v === null)).toBe(true)
    expect(r.fires.length).toBeGreaterThan(0)
  })
})

describe('runBacktest — trigger variants', () => {
  it('fires on a signalChange trigger when the value moves', () => {
    const rule: BacktestRule = {
      side: 'left',
      cooldownMin: null,
      trigger: { kind: 'signalChange', signal: 'left.movement' },
      conditions: vacuous,
      actions: [{ kind: 'notify', message: 'moved' }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })
    // movementSeries steps between 100 and 300 twice → at least two changes.
    expect(r.fires.length).toBeGreaterThanOrEqual(2)
    expect(r.primary).toBeNull()
  })

  it('fires once on a timeOfDay trigger at the matching minute', () => {
    const rule: BacktestRule = {
      side: 'left',
      cooldownMin: null,
      trigger: { kind: 'timeOfDay', at: '00:05', days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] },
      conditions: vacuous,
      actions: [{ kind: 'notify', message: 'bedtime' }] as Action[],
    }
    // 1970-01-01T00:00Z is a Thursday; the window spans 00:00–01:00 UTC.
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.fires).toEqual([5])
  })
})

describe('runBacktest — edge-mode setpoint deltas', () => {
  const edgeRule = (temp: Action): BacktestRule => ({
    side: 'left',
    cooldownMin: null,
    trigger: tick,
    conditions: vacuous,
    actions: [temp] as Action[],
  })

  it('derives the delta from a literal setpoint relative to the nominal baseline', () => {
    const rule = edgeRule({ kind: 'setTemperature', temp: lit(80), clamp: { min: 60, max: 75 } } as Action)
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.mode).toBe('edge')
    // nominal = round((60+75)/2) = 68; literal 80 → +12 → clamped to 75.
    expect(r.setpoint.some(v => v === 75)).toBe(true)
  })

  it('treats a bare currentTemperature setpoint as a zero delta', () => {
    const rule = edgeRule({ kind: 'setTemperature', temp: sig('left.currentTemperature'), clamp: { min: 60, max: 75 } } as Action)
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.mode).toBe('edge')
    expect(r.summary.netEffect).toContain('0°F')
  })

  it('reads the delta from a literal on the left of the binary', () => {
    // current + 2 written as 2 + current → the literal operand is on the left.
    const rule = edgeRule({ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: lit(2), right: sig('left.currentTemperature') }, clamp: { min: 60, max: 75 } } as Action)
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.summary.netEffect).toContain('+2°F')
  })
})

describe('runBacktest — policy time windows', () => {
  const policyWindowRule = (start: string, end: string): BacktestRule => ({
    side: null,
    cooldownMin: null,
    trigger: tick,
    conditions: { kind: 'and', conditions: [{ kind: 'timeBetween', start, end }] } as Condition,
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }, clamp: { min: 60, max: 75 } }] as Action[],
  })

  it('only emits a setpoint inside a same-day window', () => {
    const r = runBacktest({ rule: policyWindowRule('00:10', '00:20'), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(68) } })
    expect(r.mode).toBe('policy')
    expect(r.setpoint[0]).toBeNull() // 00:00 is outside the window
    expect(r.setpoint[12]).toBe(71) // 00:12 is inside → 68 + 3
    expect(r.setpoint[30]).toBeNull() // 00:30 is outside again
  })

  it('handles a window that wraps past midnight', () => {
    const r = runBacktest({ rule: policyWindowRule('00:50', '00:10'), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(68) } })
    expect(r.setpoint[5]).toBe(71) // 00:05 is inside the wrapped window
    expect(r.setpoint[30]).toBeNull() // 00:30 is outside
  })

  it('treats a zero-width window (start === end) as always outside', () => {
    const r = runBacktest({ rule: policyWindowRule('01:00', '01:00'), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(68) } })
    expect(r.setpoint.every(v => v === null)).toBe(true)
  })
})

describe('runBacktest — condition-tree introspection', () => {
  it('finds a comparison nested inside a NOT and a time window inside a NOT', () => {
    const rule: BacktestRule = {
      side: 'left',
      cooldownMin: null,
      trigger: tick,
      conditions: {
        kind: 'and',
        conditions: [
          { kind: 'not', condition: { kind: 'compare', op: '>', left: sig('left.movement'), right: lit(200) } },
          { kind: 'timeBetween', start: '23:00', end: '06:00' },
        ],
      } as Condition,
      actions: [{ kind: 'notify', message: 'x' }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })
    expect(r.primary?.key).toBe('left.movement')
    expect(r.timeWindow).toEqual({ startMin: 23 * 60, endMin: 6 * 60 })
  })

  it('skips literal-left comparisons and reads through a clamp to the driving signal', () => {
    const rule: BacktestRule = {
      side: 'left',
      cooldownMin: null,
      trigger: tick,
      conditions: {
        kind: 'and',
        conditions: [
          { kind: 'compare', op: '>', left: lit(5), right: lit(1) }, // literal left → no signal
          { kind: 'compare', op: '>', left: { kind: 'clamp', value: sig('left.movement'), min: lit(0), max: lit(1000) }, right: lit(200) },
        ],
      } as Condition,
      actions: [{ kind: 'notify', message: 'x' }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })
    expect(r.primary?.key).toBe('left.movement')
  })
})
