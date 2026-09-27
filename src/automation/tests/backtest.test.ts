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
      temp: { kind: 'binary', op: '-', left: { kind: 'signal', signal: 'left.targetTemperature' }, right: { kind: 'literal', value: 2 } },
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
    expect(r.summary.netEffect).toContain('82.5°F')
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

  it('tracks ambient + 3 and counts eligible actions', () => {
    const r = runBacktest({ rule: policyRule(), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(70) } })
    expect(r.mode).toBe('policy')
    expect(r.fires.length).toBe(61)
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
    // Literal 80 is evaluated directly and clamped to 75.
    expect(r.setpoint.some(v => v === 75)).toBe(true)
  })

  it('evaluates a bare targetTemperature with nominal fallback', () => {
    const rule = edgeRule({ kind: 'setTemperature', temp: sig('left.targetTemperature'), clamp: { min: 60, max: 75 } } as Action)
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.mode).toBe('edge')
    expect(r.summary.netEffect).toContain('Target persists')
  })

  it('reads the delta from a literal on the left of the binary', () => {
    // current + 2 written as 2 + current → the literal operand is on the left.
    const rule = edgeRule({ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: lit(2), right: sig('left.targetTemperature') }, clamp: { min: 60, max: 75 } } as Action)
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.setpoint[0]).toBe(70)
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

  it('asserts inside a same-day window and retains the target afterward', () => {
    const r = runBacktest({ rule: policyWindowRule('00:10', '00:20'), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(68) } })
    expect(r.mode).toBe('policy')
    expect(r.setpoint[0]).toBeNull() // 00:00 is outside the window
    expect(r.setpoint[12]).toBe(71) // 00:12 is inside → 68 + 3
    expect(r.setpoint[30]).toBe(71) // outside the window does not undo the last command
  })

  it('handles a window that wraps past midnight', () => {
    const r = runBacktest({ rule: policyWindowRule('00:50', '00:10'), timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: { 'ambient.temperature': ambientSeries(68) } })
    expect(r.setpoint[5]).toBe(71) // 00:05 is inside the wrapped window
    expect(r.setpoint[30]).toBe(71) // outside retains target
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
    // A single sample at t=0; by 00:20 it exceeds the five-minute freshness bound.
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

  it('skips a temperature action with an unavailable operand', () => {
    const rule: BacktestRule = {
      side: 'left', cooldownMin: null, trigger: tick, conditions: vacuous,
      actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: sig('left.targetTemperature'), right: sig('ambient.temperature') }, clamp: { min: 60, max: 75 } }] as Action[],
    }
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: HOUR, stepMin: 1, series: {} })
    expect(r.mode).toBe('edge')
    expect(r.fires).toEqual([])
    expect(r.setpoint.every(v => v === null)).toBe(true)
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

describe('replay decision regressions', () => {
  const base = (trigger: Trigger = tick): BacktestRule => ({
    side: 'left', cooldownMin: null, trigger, conditions: vacuous,
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }, clamp: { min: 60, max: 75 } }],
  })
  const replay = (rule: BacktestRule, stepMin = 1, endMs = 10 * 60_000) => runBacktest({
    rule, timezone: 'UTC', startMs: 0, endMs, stepMin,
    series: { 'ambient.temperature': [{ t: 0, v: 68 }, { t: 60_000, v: 70 }, { t: 120_000, v: 69 }] },
  })

  it('applies tick cadence, nested condition and cooldown in policy mode', () => {
    const rule = base({ kind: 'tick', everyMin: 2 })
    rule.cooldownMin = 5
    rule.conditions = { kind: 'and', conditions: [
      { kind: 'onDays', days: ['thursday'] },
      { kind: 'not', condition: { kind: 'timeBetween', start: '00:00', end: '00:02' } },
    ] }
    const r = replay(rule)
    expect(r.fires).toEqual([2, 8])
    expect(r.suppressed).toEqual([4, 6, 10])
    expect(r.setpoint[0]).toBeNull()
  })

  it('requires changes in policy mode and retains the evaluated ambient expression', () => {
    const r = replay(base({ kind: 'signalChange', signal: 'ambient.temperature' }))
    expect(r.fires).toEqual([1, 2])
    expect(r.setpoint).toEqual([null, 73, 72, 72, 72, 72, 72, 72, 72, 72, 72])
  })

  it('feeds every window operand and keeps decision resolution independent of chart step', () => {
    const rule = base()
    rule.conditions = { kind: 'compare', op: '>=', left: { kind: 'window', fn: 'count', signal: 'ambient.temperature', lastMin: 10 }, right: lit(3) }
    rule.actions = [{ kind: 'setTemperature', temp: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 } }]
    const input = { rule, timezone: 'UTC', startMs: 0, endMs: 10 * 60_000, series: { 'ambient.temperature': [{ t: 0, v: 68 }], 'left.movement': [{ t: 0, v: 70 }] } }
    const fine = runBacktest(input)
    const coarse = runBacktest({ ...input, stepMin: 2 })
    expect(fine.fires[0]).toBe(2)
    expect(fine.setpoint[2]).toBe(70)
    expect(coarse.summary).toEqual(fine.summary)
    expect(coarse.setpoint).toEqual(fine.setpoint.filter((_, i) => i % 2 === 0))
  })

  it('expires latest duration to firmware neutral instead of undoing to baseline', () => {
    const rule = base({ kind: 'signalChange', signal: 'ambient.temperature' })
    rule.actions = [{ kind: 'setTemperature', temp: lit(65), durationSec: 120 }]
    expect(replay(rule).setpoint.slice(0, 6)).toEqual([null, 65, 65, 65, 82.5, 82.5])
  })

  it('evaluates multiplication against nominal target without inventing measured temperature', () => {
    const rule = base({ kind: 'timeOfDay', at: '00:00' })
    rule.actions = [{ kind: 'setTemperature', temp: { kind: 'binary', op: '*', left: sig('left.targetTemperature'), right: lit(0.9) }, clamp: { min: 60, max: 100 } }]
    expect(replay(rule).setpoint[0]).toBe(72)
    rule.actions = [{ kind: 'setTemperature', temp: sig('left.currentTemperature') }]
    expect(replay(rule).fires).toEqual([])
  })

  it('keeps unclamped ghost values out of resulting setpoint range', () => {
    const rule = base()
    rule.actions = [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(20) }, clamp: { min: 60, max: 75 } }]
    expect(replay(rule).summary.setpointRange).toEqual([75, 75])
  })

  it('timeOfDay honors grace and rearms on the same weekday next week', () => {
    const rule = base({ kind: 'timeOfDay', at: '00:00', days: ['thursday'] })
    rule.actions = [{ kind: 'notify', message: 'slot' }]
    const r = runBacktest({ rule, timezone: 'UTC', startMs: 5 * 60_000, endMs: 7 * 24 * HOUR + 5 * 60_000, series: {} })
    expect(r.fires).toHaveLength(2)
    expect(r.fires[0]).toBe(0)
  })

  it('expires movement after five minutes and cap after thirty seconds', () => {
    for (const [key, expected] of [['left.movement', 6], ['left.cap.max', 1]] as const) {
      const rule = base()
      rule.conditions = { kind: 'compare', op: '>', left: sig(key), right: lit(0) }
      rule.actions = [{ kind: 'notify', message: 'fresh' }]
      const r = runBacktest({ rule, timezone: 'UTC', startMs: 0, endMs: 10 * 60_000, series: { [key]: [{ t: 0, v: 1 }] } })
      expect(r.fires).toHaveLength(expected)
    }
  })
})

describe('live evaluator parity', () => {
  it.each<Trigger>([
    { kind: 'tick', everyMin: 2 },
    { kind: 'signalChange', signal: 'ambient.temperature' },
    { kind: 'timeOfDay', at: '00:02' },
  ])('matches live trigger/condition/cooldown decisions for $kind', async (trigger) => {
    const { AutomationEngine } = await import('../engine')
    const { clockInTimezone } = await import('../signals')
    const startMs = Date.parse('2026-09-24T00:00:00Z')
    let nowMs = startMs
    let value = 70
    const firedMinutes: number[] = []
    const rule = {
      id: 1, name: 'parity', enabled: true, priority: 0, dryRun: false,
      side: 'left' as const, cooldownMin: 3, trigger,
      conditions: { kind: 'and' as const, conditions: [
        { kind: 'onDays' as const, days: ['thursday' as const] },
        { kind: 'compare' as const, op: '>' as const, left: { kind: 'window' as const, fn: 'count' as const, signal: 'ambient.temperature', lastMin: 5 }, right: lit(1) },
      ] },
      actions: [{ kind: 'notify' as const, message: 'eligible' }],
    }
    const engine = new AutomationEngine({
      signals: { read: () => ({ 'ambient.temperature': value }) },
      now: () => nowMs, clock: () => clockInTimezone('UTC', new Date(nowMs)),
      getHardware: () => { throw new Error('notify does not use hardware') },
      withSideLock: async (_side, fn) => fn(), pumpStallShouldBlock: () => false,
      broadcast: () => {}, markMutated: () => {}, loadRules: async () => [rule],
      recordRun: async () => {}, disableRule: async () => {},
      hasActiveRunOnceSession: async () => false, isAwayMode: async () => false,
      notify: () => { firedMinutes.push((nowMs - startMs) / 60_000) },
    })
    await engine.reload()
    const series: Sample[] = []
    for (let minute = 0; minute <= 10; minute++) {
      nowMs = startMs + minute * 60_000
      value = 70 + minute % 3
      series.push({ t: nowMs, v: value })
      await engine.tick()
    }
    const replay = runBacktest({ rule, timezone: 'UTC', startMs, endMs: nowMs, series: { 'ambient.temperature': series } })
    expect(replay.fires).toEqual(firedMinutes)
  })
})
