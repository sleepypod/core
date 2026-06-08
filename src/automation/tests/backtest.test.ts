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

describe('runBacktest — sampling & introspection corners', () => {
  const notifyOn = (conditions: Condition): BacktestRule => ({
    side: 'left', cooldownMin: null, trigger: tick, conditions, actions: [{ kind: 'notify', message: 'x' }] as Action[],
  })

  it('defaults the step size to 1 minute when none is given', () => {
    const r = runBacktest({ rule: notifyOn(vacuous), timezone: 'UTC', startMs: 0, endMs: HOUR, series: {} })
    expect(r.stepMin).toBe(1)
  })

  it('reports a null threshold for a compare whose right side is not a literal', () => {
    const cond: Condition = { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: sig('left.heartRate') }] }
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })
    expect(r.threshold).toBeNull()
    expect(r.primary?.key).toBe('left.movement')
  })

  it('labels a primary signal that has no friendly name with its raw key', () => {
    const cond: Condition = { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.targetTemperature'), right: lit(70) }] }
    const series = { 'left.targetTemperature': ambientSeries(72) }
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series })
    expect(r.primary?.label).toBe('left.targetTemperature')
  })

  it('treats an empty sample buffer as no data', () => {
    const cond: Condition = { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(50) }] }
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': [] } })
    expect(r.primary?.values.every(v => v === null)).toBe(true)
    expect(r.fires.length).toBe(0)
  })

  it('ignores samples that lie entirely in the future', () => {
    const cond: Condition = { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(50) }] }
    // The only sample is 10h ahead of the whole replay window.
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': [{ t: 10 * HOUR, v: 300 }] } })
    expect(r.primary?.values.every(v => v === null)).toBe(true)
  })

  it('treats a sample older than the staleness bound as unavailable', () => {
    const cond: Condition = { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(50) }] }
    // A single sample at t=0; by 00:20 it is >15 min stale.
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': [{ t: 0, v: 300 }] } })
    expect(r.primary?.values[0]).toBe(300) // fresh
    expect(r.primary?.values[20]).toBeNull() // stale
  })

  it('produces null aggregate values for a windowed compare with no data', () => {
    const cond: Condition = {
      kind: 'and',
      conditions: [{ kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: lit(200) }],
    }
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.avg?.values.every(v => v === null)).toBe(true)
    expect(r.fires.length).toBe(0)
  })

  it('never fires a signalChange trigger when the signal is absent', () => {
    const rule: BacktestRule = {
      side: 'left', cooldownMin: null, trigger: { kind: 'signalChange', signal: 'left.movement' },
      conditions: vacuous, actions: [{ kind: 'notify', message: 'x' }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.fires.length).toBe(0)
  })

  it('fires a timeOfDay trigger only once even when multiple steps share a minute', () => {
    const rule: BacktestRule = {
      side: 'left', cooldownMin: null, trigger: { kind: 'timeOfDay', at: '00:05' },
      conditions: vacuous, actions: [{ kind: 'notify', message: 'x' }] as Action[],
    }
    // Half-minute steps put two steps inside minute 5; the second must dedupe.
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 0.5, series: {} })
    expect(r.fires).toHaveLength(1)
  })

  it('reports a zero net delta for an edge action that subtracts two signals', () => {
    const rule: BacktestRule = {
      side: 'left', cooldownMin: null, trigger: tick, conditions: vacuous,
      actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: sig('left.currentTemperature'), right: sig('ambient.temperature') }, clamp: { min: 60, max: 75 } }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.mode).toBe('edge')
    expect(r.summary.netEffect).toContain('0°F')
  })

  it('reads through a clamp whose inner value is a literal to a bounding signal', () => {
    const rule: BacktestRule = {
      side: null, cooldownMin: null, trigger: tick, conditions: vacuous,
      actions: [{ kind: 'setTemperature', temp: { kind: 'clamp', value: lit(72), min: sig('ambient.temperature'), max: lit(75) }, clamp: { min: 60, max: 75 } }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(65) } })
    // The clamp's bounding signal is ambient → policy mode tracking ambient.
    expect(r.mode).toBe('policy')
  })

  it('rounds a non-positive primary axis maximum up to a whole number', () => {
    const cond: Condition = { kind: 'and', conditions: [{ kind: 'compare', op: '>', left: sig('left.movement'), right: lit(0) }] }
    const series = { 'left.movement': ambientSeries(0) } // every sample is 0
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series })
    expect(r.primaryAxis?.max).toBe(0)
  })
})

describe('runBacktest — stateful & derived conditions', () => {
  const notifyOn = (conditions: Condition): BacktestRule => ({
    side: 'left', cooldownMin: null, trigger: tick, conditions, actions: [{ kind: 'notify', message: 'x' }] as Action[],
  })

  it('debounces a sustained condition across replay steps', () => {
    // movementSeries() bursts to 300 for minutes 10–40. Sustained-for-5-min
    // means fires begin only at minute 15 and stop after the burst ends.
    const cond: Condition = {
      kind: 'sustained',
      forMin: 5,
      condition: { kind: 'compare', op: '>', left: sig('left.movement'), right: lit(200) },
    }
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': movementSeries() } })
    // Surfaces the wrapped compare as the primary trace via sustained recursion.
    expect(r.primary?.key).toBe('left.movement')
    expect(r.fires).toContain(15) // 5 min after the burst started at minute 10
    expect(r.fires).not.toContain(11) // streak not yet long enough
    expect(r.fires).not.toContain(45) // burst is over
  })

  it('latches a hysteresis condition with a dead-band across steps', () => {
    // Movement ramps 0→59 (×5 ≈ 0..295). on=200 (minute 40), off=100 (minute 20 on the way down).
    const ramp: Sample[] = []
    for (let i = 0; i < 60; i++) {
      const v = i < 45 ? i * 5 : (60 - i) * 5 // up to 220 then back down
      ramp.push({ t: i * 60_000, v })
    }
    const cond: Condition = { kind: 'hysteresis', subject: sig('left.movement'), on: 200, off: 100 }
    const r = runBacktest({ rule: notifyOn(cond), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'left.movement': ramp } })
    expect(r.fires).toContain(40) // first minute movement reaches 200
    expect(r.fires).not.toContain(10) // below `on`, never latched
  })

  it('evaluates a z-score condition against supplied baselines', () => {
    const hr: Sample[] = []
    for (let i = 0; i < 60; i++) hr.push({ t: i * 60_000, v: i < 30 ? 62 : 80 }) // normal then +4σ
    const cond: Condition = { kind: 'compare', op: '>', left: sig('left.heartRate.zscore'), right: lit(2) }
    const r = runBacktest({
      rule: notifyOn(cond),
      timezone: 'UTC',
      startMs: 0,
      endMs: HOUR,
      stepMin: 1,
      series: { 'left.heartRate': hr },
      baselines: { left: { hrMean: 60, hrSD: 5 } },
    })
    expect(r.fires).not.toContain(10) // 62 bpm → +0.4σ
    expect(r.fires).toContain(30) // 80 bpm → +4σ
  })
})
