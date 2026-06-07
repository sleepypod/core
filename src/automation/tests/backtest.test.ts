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
