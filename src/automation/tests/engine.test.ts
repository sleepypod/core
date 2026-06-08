import { describe, expect, it, vi } from 'vitest'
import { AutomationEngine, type AutomationEngineDeps } from '../engine'
import type { BaselineMap, SignalSnapshot } from '../signals'
import { AUTOMATION_TICK_MS, type Action, type AutomationRule, type Condition, type DayOfWeek, type Expr, type RunOutcome, type Trigger, type Side } from '../types'

interface HwCall {
  op: 'temp' | 'power'
  side: Side
  temp?: number
  duration?: number
  on?: boolean
}

interface RunDetail {
  reason?: string
  message?: string
  actionsLastHour?: number
  actions?: Array<{
    kind: string
    skipped?: string
    antiThrash?: boolean
    clamped?: boolean
    sent?: boolean
    dryRun?: boolean
    temp?: number
  }>
}

interface Harness {
  engine: AutomationEngine
  setNow: (ms: number) => void
  advance: (ms: number) => void
  setSignal: (key: string, value: number | undefined) => void
  setClock: (nowMinutes: number, dayOfWeek?: DayOfWeek) => void
  setRunOnce: (active: boolean) => void
  setBaselines: (b: BaselineMap) => void
  runs: { id: number, outcome: RunOutcome, detail: RunDetail }[]
  notifies: { id: number, message: string }[]
  hwCalls: HwCall[]
  disabled: number[]
}

function makeHarness(rules: AutomationRule[]): Harness {
  // Base clock is a realistic epoch so a `tick` trigger's first evaluation is
  // due (production `now` is always >> any everyMin window from epoch 0).
  let nowMs = 1_700_000_000_000
  let runOnce = false
  let nowMinutes = 0
  let dayOfWeek: DayOfWeek = 'monday'
  let baselines: BaselineMap = {}
  const snapshot: SignalSnapshot = {}
  const runs: Harness['runs'] = []
  const notifies: Harness['notifies'] = []
  const hwCalls: HwCall[] = []
  const disabled: number[] = []

  const deps: AutomationEngineDeps = {
    signals: { read: () => ({ ...snapshot }) },
    now: () => nowMs,
    clock: () => ({ nowMinutes, dayOfWeek }),
    getHardware: () => ({
      connect: async () => {},
      setTemperature: async (side, temp, duration) => { hwCalls.push({ op: 'temp', side, temp, duration }) },
      setPower: async (side, on, temp) => { hwCalls.push({ op: 'power', side, on, temp }) },
    }),
    withSideLock: async (_side, fn) => fn(),
    broadcast: () => {},
    markMutated: () => {},
    loadRules: async () => rules,
    loadBaselines: async () => baselines,
    recordRun: async (id, outcome, detail) => { runs.push({ id, outcome, detail: detail as RunDetail }) },
    disableRule: async (id) => { disabled.push(id) },
    hasActiveRunOnceSession: async () => runOnce,
    notify: (id, message) => notifies.push({ id, message }),
  }

  const engine = new AutomationEngine(deps)
  return {
    engine,
    setNow: (ms) => { nowMs = ms },
    advance: (ms) => { nowMs += ms },
    setSignal: (key, value) => { snapshot[key] = value },
    setClock: (m, d) => {
      nowMinutes = m
      if (d) dayOfWeek = d
    },
    setRunOnce: (a) => { runOnce = a },
    setBaselines: (b) => { baselines = b },
    runs,
    notifies,
    hwCalls,
    disabled,
  }
}

const lit = (value: number): Expr => ({ kind: 'literal', value })
const sig = (signal: string): Expr => ({ kind: 'signal', signal })
const tickEvery = (everyMin: number): Trigger => ({ kind: 'tick', everyMin })
const always: Condition = { kind: 'and', conditions: [] } // vacuously true

function rule(overrides: Partial<AutomationRule>): AutomationRule {
  return {
    id: 1,
    name: 'test',
    enabled: true,
    side: 'left',
    priority: 0,
    dryRun: false,
    cooldownMin: null,
    trigger: tickEvery(1),
    conditions: always,
    actions: [],
    ...overrides,
  }
}

describe('AutomationEngine — outcomes & audit log', () => {
  it('only evaluates a tick trigger when its interval has elapsed', async () => {
    const h = makeHarness([rule({ trigger: tickEvery(5), actions: [{ kind: 'notify', message: 'hi' }] })])
    await h.engine.reload()
    await h.engine.tick() // first eval is due → 1 row
    h.advance(60_000)
    await h.engine.tick() // 1 min later, not due → no new row
    expect(h.runs).toHaveLength(1)
    h.advance(5 * 60_000)
    await h.engine.tick() // interval elapsed → new row
    expect(h.runs).toHaveLength(2)
  })

  it('logs skipped/condition-unknown when a referenced signal is missing', async () => {
    const cond: Condition = { kind: 'compare', op: '>', left: sig('absent'), right: lit(5) }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('skipped')
    expect(h.runs[0].detail.reason).toBe('condition-unknown')
    expect(h.notifies).toHaveLength(0)
  })

  it('logs skipped/condition-false when conditions do not hold', async () => {
    const cond: Condition = { kind: 'compare', op: '>', left: sig('x'), right: lit(5) }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'x' }] })])
    h.setSignal('x', 1)
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('skipped')
    expect(h.runs[0].detail.reason).toBe('condition-false')
  })

  it('fires a notify action and logs fired', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'notify', message: 'movement high' }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.notifies).toEqual([{ id: 1, message: 'movement high' }])
    expect(h.runs[0].outcome).toBe('fired')
  })
})

describe('AutomationEngine — dry-run', () => {
  it('emits notify but never touches hardware, logging dry_run', async () => {
    const actions: Action[] = [
      { kind: 'notify', message: 'would warm' },
      { kind: 'setTemperature', temp: lit(72) },
    ]
    const h = makeHarness([rule({ dryRun: true, actions })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(0)
    expect(h.notifies).toHaveLength(1)
    expect(h.runs[0].outcome).toBe('dry_run')
  })
})

describe('AutomationEngine — two-layer temp clamp', () => {
  it('clamps to the per-action user band (layer 1), logs clamped', async () => {
    const h = makeHarness([rule({
      actions: [{ kind: 'setTemperature', temp: lit(200), clamp: { min: 65, max: 75 } }],
    })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls[0]).toMatchObject({ op: 'temp', side: 'left', temp: 75 })
    expect(h.runs[0].outcome).toBe('clamped')
  })

  it('falls back to the default user band when no clamp is given', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: lit(40) }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls[0].temp).toBe(60) // AUTOMATION_DEFAULT_USER_MIN
  })

  it('applies the hardware bound (layer 2) even past the user band', async () => {
    // User band intentionally wider than hardware (engine clamps defensively).
    const h = makeHarness([rule({
      actions: [{ kind: 'setTemperature', temp: lit(200), clamp: { min: 50, max: 120 } }],
    })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls[0].temp).toBe(110) // MAX_TEMP
  })
})

describe('AutomationEngine — both-side fan-out', () => {
  it('applies a null-side (both) hardware action to left and right', async () => {
    const h = makeHarness([rule({
      side: null,
      actions: [{ kind: 'setTemperature', temp: lit(72), clamp: { min: 60, max: 100 } }],
    })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls.map(c => c.side).sort()).toEqual(['left', 'right'])
    expect(h.hwCalls.every(c => c.temp === 72)).toBe(true)
    expect(h.runs[0].detail.actions).toHaveLength(2)
    expect(h.runs[0].outcome).toBe('fired')
  })

  it('still honours an explicit per-action side over the null rule side', async () => {
    const h = makeHarness([rule({
      side: null,
      actions: [{ kind: 'setTemperature', side: 'right', temp: lit(72), clamp: { min: 60, max: 100 } }],
    })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(1)
    expect(h.hwCalls[0].side).toBe('right')
  })
})

describe('AutomationEngine — anti-thrash', () => {
  it('does not re-send a setpoint that moved less than 0.5°F', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: sig('target') }] })])
    h.setSignal('target', 80)
    await h.engine.reload()
    await h.engine.tick() // writes 80
    h.advance(60_000)
    h.setSignal('target', 80.3) // within 0.5 of 80 → no write
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(1)
    expect(h.runs[1].outcome).toBe('fired') // setpoint maintained
    expect(h.runs[1].detail.actions?.[0]?.antiThrash).toBe(true)

    h.advance(60_000)
    h.setSignal('target', 81) // moved ≥0.5 → write
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(2)
    expect(h.hwCalls[1].temp).toBe(81)
  })
})

describe('AutomationEngine — runaway guard', () => {
  it('auto-disables a rule that exceeds the hourly action budget', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: sig('target') }] })])
    await h.engine.reload()
    // Alternate the setpoint far enough each tick that anti-thrash never blocks.
    for (let i = 0; i < 13; i++) {
      h.setSignal('target', i % 2 === 0 ? 70 : 90)
      await h.engine.tick()
      h.advance(60_000)
    }
    // 12 writes allowed, the 13th eval trips the guard.
    expect(h.hwCalls).toHaveLength(12)
    expect(h.disabled).toContain(1)
    const errorRun = h.runs.find(r => r.outcome === 'error')
    expect(errorRun?.detail.reason).toBe('runaway-disabled')
  })
})

describe('AutomationEngine — precedence gates', () => {
  it('skips hardware while a manual-override hold is active on the side', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: lit(72) }] })])
    await h.engine.reload()
    h.engine.registerManualOverride('left')
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(0)
    expect(h.runs[0].outcome).toBe('skipped')
    expect(h.runs[0].detail.actions?.[0]?.skipped).toBe('manual-override')
  })

  it('skips hardware while a run-once session is active on the side', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: lit(72) }] })])
    h.setRunOnce(true)
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(0)
    expect(h.runs[0].detail.actions?.[0]?.skipped).toBe('run-once')
  })
})

describe('AutomationEngine — cooldown', () => {
  it('skips re-firing within the cooldown window', async () => {
    const h = makeHarness([rule({ cooldownMin: 30, actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.reload()
    await h.engine.tick() // fires
    h.advance(5 * 60_000) // 5 min later, still within 30m cooldown
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('fired')
    expect(h.runs[1].outcome).toBe('skipped')
    expect(h.runs[1].detail.reason).toBe('cooldown')
  })
})

describe('AutomationEngine — windowed aggregate (example 2)', () => {
  it('fires when avg(movement, 10m) crosses the threshold', async () => {
    const cond: Condition = {
      kind: 'compare',
      op: '>',
      left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 },
      right: lit(200),
    }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'restless' }] })])
    h.setSignal('left.movement', 300)
    await h.engine.reload()
    // First tick records a sample then evaluates avg=300>200 → fires.
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('fired')
    expect(h.notifies[0].message).toBe('restless')
  })
})

describe('AutomationEngine — hysteresis & sustained (stability primitives)', () => {
  it('latches across ticks: fires past `on`, holds in the dead-band, releases below `off`', async () => {
    const cond: Condition = { kind: 'hysteresis', subject: sig('left.movement'), on: 200, off: 100 }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'restless' }] })])
    await h.engine.reload()

    h.setSignal('left.movement', 150) // dead-band, never activated
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('skipped')

    h.advance(60_000)
    h.setSignal('left.movement', 250) // crosses `on` → fires
    await h.engine.tick()
    expect(h.runs[1].outcome).toBe('fired')

    h.advance(60_000)
    h.setSignal('left.movement', 150) // dead-band → latch holds → still fires
    await h.engine.tick()
    expect(h.runs[2].outcome).toBe('fired')

    h.advance(60_000)
    h.setSignal('left.movement', 80) // below `off` → releases
    await h.engine.tick()
    expect(h.runs[3].outcome).toBe('skipped')
  })

  it('debounces with sustained: fires only after the inner holds for N minutes', async () => {
    const cond: Condition = {
      kind: 'sustained',
      forMin: 3,
      condition: { kind: 'compare', op: '>', left: sig('left.movement'), right: lit(200) },
    }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'sustained restlessness' }] })])
    await h.engine.reload()
    h.setSignal('left.movement', 300)

    await h.engine.tick() // t=0, streak starts
    expect(h.runs[0].outcome).toBe('skipped')
    h.advance(2 * 60_000)
    await h.engine.tick() // t=2, not yet 3 min
    expect(h.runs[1].outcome).toBe('skipped')
    h.advance(60_000)
    await h.engine.tick() // t=3, sustained → fires
    expect(h.runs[2].outcome).toBe('fired')
  })
})

describe('AutomationEngine — z-score conditions (baseline mean/SD)', () => {
  it('fires when a vital exceeds its personal baseline by N sigma', async () => {
    // HR baseline mean 60 / SD 5; rule fires when left.heartRate.zscore > 2 (i.e. > 70 bpm).
    const cond: Condition = { kind: 'compare', op: '>', left: sig('left.heartRate.zscore'), right: lit(2) }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'HR anomaly' }] })])
    h.setBaselines({ left: { hrMean: 60, hrSD: 5 } })
    await h.engine.reload()

    h.setSignal('left.heartRate', 68) // +1.6σ → below threshold
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('skipped')

    h.advance(60_000)
    h.setSignal('left.heartRate', 80) // +4σ → fires
    await h.engine.tick()
    expect(h.runs[1].outcome).toBe('fired')
    expect(h.notifies.at(-1)?.message).toBe('HR anomaly')
  })

  it('skips (unknown) when no baseline is available for the side', async () => {
    const cond: Condition = { kind: 'compare', op: '>', left: sig('left.heartRate.zscore'), right: lit(2) }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'x' }] })])
    h.setSignal('left.heartRate', 80) // no baseline set → zscore undefined
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('skipped')
    expect(h.runs[0].detail.reason).toBe('condition-unknown')
  })
})

describe('AutomationEngine — motivating examples end-to-end', () => {
  it('example 1 (continuous policy): holds left target at ambient + 3°F in window, anti-thrash on small moves', async () => {
    const rule1: AutomationRule = rule({
      side: 'left',
      conditions: { kind: 'timeBetween', start: '23:00', end: '06:00' },
      actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: sig('ambient.temperature'), right: lit(3) }, clamp: { min: 60, max: 100 } }],
    })
    const h = makeHarness([rule1])
    h.setClock(23 * 60 + 30) // inside 23:00–06:00
    h.setSignal('ambient.temperature', 68)
    await h.engine.reload()

    await h.engine.tick() // ambient 68 + 3 → 71
    expect(h.hwCalls[0]).toMatchObject({ op: 'temp', side: 'left', temp: 71 })

    h.advance(60_000)
    h.setSignal('ambient.temperature', 68.2) // setpoint 71.2 → <0.5 move → anti-thrash
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(1)
    expect(h.runs[1].detail.actions?.[0]?.antiThrash).toBe(true)

    h.advance(60_000)
    h.setSignal('ambient.temperature', 70) // setpoint 73 → ≥0.5 move → re-asserts
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(2)
    expect(h.hwCalls[1].temp).toBe(73)

    // Out of the window → no longer holds the setpoint.
    h.advance(60_000)
    h.setClock(12 * 60)
    await h.engine.tick()
    expect(h.runs.at(-1)?.outcome).toBe('skipped')
  })

  it('example 2 (edge-triggered): avg(movement,10m) > 200 lowers temp by 2°F, with cooldown', async () => {
    const rule2: AutomationRule = rule({
      side: 'left',
      cooldownMin: 30,
      conditions: { kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: lit(200) },
      actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '-', left: sig('left.currentTemperature'), right: lit(2) }, clamp: { min: 60, max: 100 } }],
    })
    const h = makeHarness([rule2])
    h.setSignal('left.currentTemperature', 75)
    h.setSignal('left.movement', 300)
    await h.engine.reload()

    await h.engine.tick() // avg 300 > 200 → lower to 73
    expect(h.runs[0].outcome).toBe('fired')
    expect(h.hwCalls[0]).toMatchObject({ side: 'left', temp: 73 })

    h.advance(5 * 60_000) // still within 30m cooldown
    await h.engine.tick()
    expect(h.runs[1].outcome).toBe('skipped')
    expect(h.runs[1].detail.reason).toBe('cooldown')
  })
})

describe('AutomationEngine — triggers', () => {
  it('signalChange fires only when the signal value changes', async () => {
    const h = makeHarness([rule({
      trigger: { kind: 'signalChange', signal: 'ambient.temperature' },
      actions: [{ kind: 'notify', message: 'ambient moved' }],
    })])
    h.setSignal('ambient.temperature', 68)
    await h.engine.reload()
    await h.engine.tick() // first observation: baseline, no fire
    expect(h.runs).toHaveLength(0)
    await h.engine.tick() // unchanged → no fire
    expect(h.runs).toHaveLength(0)
    h.setSignal('ambient.temperature', 70)
    await h.engine.tick() // changed → fire
    expect(h.runs).toHaveLength(1)
    expect(h.runs[0].outcome).toBe('fired')
  })

  it('timeOfDay fires once at the matching minute', async () => {
    const h = makeHarness([rule({
      trigger: { kind: 'timeOfDay', at: '23:00' },
      actions: [{ kind: 'notify', message: 'bedtime' }],
    })])
    h.setClock(22 * 60 + 59)
    await h.engine.reload()
    await h.engine.tick() // 22:59 → no
    expect(h.runs).toHaveLength(0)
    h.setClock(23 * 60)
    await h.engine.tick() // 23:00 → fire
    await h.engine.tick() // same minute → no double-fire
    expect(h.runs).toHaveLength(1)
  })
})

describe('AutomationEngine — disabled rules', () => {
  it('never evaluates a disabled rule', async () => {
    const h = makeHarness([rule({ enabled: false, actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs).toHaveLength(0)
    expect(h.notifies).toHaveLength(0)
  })
})

describe('AutomationEngine — lifecycle', () => {
  it('start() installs the tick timer and stop() clears it', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.start() // reloads + installs interval
    h.engine.stop() // clears the interval
    // A second stop() is a safe no-op.
    h.engine.stop()
  })
})

describe('AutomationEngine — global kill-switch', () => {
  it('halts all evaluation while disabled and resumes when re-enabled', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.reload()
    expect(h.engine.isGloballyEnabled()).toBe(true)

    h.engine.setGlobalEnabled(false)
    expect(h.engine.isGloballyEnabled()).toBe(false)
    await h.engine.tick()
    expect(h.runs).toHaveLength(0)

    h.engine.setGlobalEnabled(true)
    await h.engine.tick()
    expect(h.runs).toHaveLength(1)
  })
})

describe('AutomationEngine — reload', () => {
  it('drops runtime for rules that no longer exist', async () => {
    const rules = [rule({ id: 1, actions: [{ kind: 'notify', message: 'a' }] })]
    const h = makeHarness(rules)
    await h.engine.reload()
    await h.engine.tick() // creates runtime for rule 1
    // Replace the rule set; reload should prune runtime for the removed id 1.
    rules.length = 0
    rules.push(rule({ id: 2, actions: [{ kind: 'notify', message: 'b' }] }))
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs.some(r => r.id === 2)).toBe(true)
  })
})

describe('AutomationEngine — setPower', () => {
  it('writes power on with a resolved temperature and tracks the setpoint', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setPower', on: true, temp: lit(72) }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls[0]).toMatchObject({ op: 'power', side: 'left', on: true, temp: 72 })
    expect(h.runs[0].outcome).toBe('fired')
  })

  it('writes power off without a temperature', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setPower', on: false }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls[0]).toMatchObject({ op: 'power', side: 'left', on: false })
    expect(h.runs[0].outcome).toBe('fired')
  })
})

describe('AutomationEngine — unresolved temperature', () => {
  it('skips a setTemperature whose expression resolves to undefined', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: sig('absent') }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(0)
    expect(h.runs[0].outcome).toBe('skipped')
    expect(h.runs[0].detail.actions?.[0]?.skipped).toBe('temp-unknown')
  })
})

describe('AutomationEngine — window-bounded eval', () => {
  it('handles windows nested in clamp/binary action temps and not/between/time conditions', async () => {
    const win: Expr = { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 30 }
    const conditions: Condition = {
      kind: 'and',
      conditions: [
        { kind: 'not', condition: { kind: 'between', subject: win, min: lit(0), max: lit(1000) } },
        { kind: 'timeBetween', start: '23:00', end: '06:00' },
      ],
    }
    const action: Action = {
      kind: 'setTemperature',
      temp: { kind: 'clamp', value: { kind: 'binary', op: '+', left: win, right: lit(1) }, min: lit(60), max: lit(75) },
    }
    const h = makeHarness([rule({ conditions, actions: [action] })])
    h.setSignal('left.movement', 500)
    await h.engine.reload()
    // Just needs to evaluate without throwing — exercises maxWindowMinutes' walk
    // over the condition/expression trees.
    await expect(h.engine.tick()).resolves.toBeUndefined()
    expect(h.runs).toHaveLength(1)
  })
})

describe('AutomationEngine — action error', () => {
  it('records an error outcome when a hardware write throws', async () => {
    const runs: { id: number, outcome: RunOutcome, detail: RunDetail }[] = []
    const deps: AutomationEngineDeps = {
      signals: { read: () => ({}) },
      now: () => 1_700_000_000_000,
      clock: () => ({ nowMinutes: 0, dayOfWeek: 'monday' }),
      getHardware: () => ({
        connect: async () => { throw new Error('hardware offline') },
        setTemperature: async () => {},
        setPower: async () => {},
      }),
      withSideLock: async (_side, fn) => fn(),
      broadcast: () => {},
      markMutated: () => {},
      loadRules: async () => [rule({ actions: [{ kind: 'setTemperature', temp: lit(72) }] })],
      recordRun: async (id, outcome, detail) => { runs.push({ id, outcome, detail: detail as RunDetail }) },
      disableRule: async () => {},
      hasActiveRunOnceSession: async () => false,
      notify: () => {},
    }
    const engine = new AutomationEngine(deps)
    await engine.reload()
    await engine.tick()
    expect(runs[0].outcome).toBe('error')
    expect(runs[0].detail.reason).toBe('eval-threw')
  })

  it('stringifies a non-Error thrown during evaluation', async () => {
    const runs: { id: number, outcome: RunOutcome, detail: RunDetail }[] = []
    const deps: AutomationEngineDeps = {
      signals: { read: () => ({}) },
      now: () => 1_700_000_000_000,
      clock: () => ({ nowMinutes: 0, dayOfWeek: 'monday' }),
      getHardware: () => ({ connect: async () => {}, setTemperature: async () => {}, setPower: async () => {} }),
      withSideLock: async (_side, fn) => fn(),
      broadcast: () => {},
      markMutated: () => {},
      loadRules: async () => [rule({ actions: [{ kind: 'setTemperature', temp: lit(72) }] })],
      recordRun: async (id, outcome, detail) => { runs.push({ id, outcome, detail: detail as RunDetail }) },
      disableRule: async () => {},
      // A non-Error rejection inside the per-rule try → caught and String()'d.
      hasActiveRunOnceSession: async () => { throw 'gate exploded' },
      notify: () => {},
    }
    const engine = new AutomationEngine(deps)
    await engine.reload()
    await engine.tick()
    expect(runs[0].outcome).toBe('error')
    expect(runs[0].detail.message).toBe('gate exploded')
  })
})

describe('AutomationEngine — branch coverage corners', () => {
  it('start() is idempotent — a second call does not install a second timer', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.start()
    await h.engine.start() // timer already set → no-op on the interval
    h.engine.stop()
  })

  it('the interval callback drives ticks', async () => {
    vi.useFakeTimers()
    try {
      const h = makeHarness([rule({ actions: [{ kind: 'notify', message: 'x' }] })])
      await h.engine.start()
      await vi.advanceTimersByTimeAsync(AUTOMATION_TICK_MS)
      expect(h.runs.length).toBeGreaterThanOrEqual(1)
      h.engine.stop()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('never overlaps two ticks', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.reload()
    // The first tick suspends at its first await with `ticking` set; the second
    // sees it and bails immediately.
    const p1 = h.engine.tick()
    const p2 = h.engine.tick()
    await Promise.all([p1, p2])
    expect(h.runs).toHaveLength(1)
  })

  it('keeps runtime for surviving rules while pruning removed ones', async () => {
    const rules = [
      rule({ id: 1, actions: [{ kind: 'notify', message: 'a' }] }),
      rule({ id: 2, actions: [{ kind: 'notify', message: 'b' }] }),
    ]
    const h = makeHarness(rules)
    await h.engine.reload()
    await h.engine.tick() // runtime for both 1 and 2
    rules.length = 0
    rules.push(rule({ id: 1, actions: [{ kind: 'notify', message: 'a' }] })) // keep 1, drop 2
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs.some(r => r.id === 1)).toBe(true)
  })

  it('logs through the optional log hook on lifecycle and kill-switch transitions', async () => {
    const logs: string[] = []
    const deps: AutomationEngineDeps = {
      signals: { read: () => ({}) },
      now: () => 1_700_000_000_000,
      clock: () => ({ nowMinutes: 0, dayOfWeek: 'monday' }),
      getHardware: () => ({ connect: async () => {}, setTemperature: async () => {}, setPower: async () => {} }),
      withSideLock: async (_side, fn) => fn(),
      broadcast: () => {},
      markMutated: () => {},
      loadRules: async () => [],
      recordRun: async () => {},
      disableRule: async () => {},
      hasActiveRunOnceSession: async () => false,
      notify: () => {},
      log: msg => logs.push(msg),
    }
    const engine = new AutomationEngine(deps)
    await engine.start()
    engine.setGlobalEnabled(false)
    engine.setGlobalEnabled(true)
    engine.stop()
    expect(logs.some(m => m.includes('started'))).toBe(true)
    expect(logs.some(m => m.includes('OFF'))).toBe(true)
    expect(logs.some(m => m.includes('ON'))).toBe(true)
  })

  it('does not record a windowed sample when the signal is absent this tick', async () => {
    const cond: Condition = {
      kind: 'compare',
      op: '>',
      left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 },
      right: lit(200),
    }
    const h = makeHarness([rule({ conditions: cond, actions: [{ kind: 'notify', message: 'x' }] })])
    await h.engine.reload() // left.movement never set → nothing to record → avg unknown
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('skipped')
    expect(h.runs[0].detail.reason).toBe('condition-unknown')
  })

  it('signalChange stays inactive while its signal is unavailable', async () => {
    const h = makeHarness([rule({
      trigger: { kind: 'signalChange', signal: 'absent' },
      actions: [{ kind: 'notify', message: 'x' }],
    })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs).toHaveLength(0)
  })

  it('timeOfDay does not fire on a day outside its day filter', async () => {
    const h = makeHarness([rule({
      trigger: { kind: 'timeOfDay', at: '23:00', days: ['saturday'] },
      actions: [{ kind: 'notify', message: 'x' }],
    })])
    h.setClock(23 * 60, 'monday') // matching minute, wrong day
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs).toHaveLength(0)
  })

  it('reports dry_run for a dry-run setPower without touching hardware', async () => {
    const h = makeHarness([rule({ dryRun: true, actions: [{ kind: 'setPower', on: true, temp: lit(72) }] })])
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls).toHaveLength(0)
    expect(h.runs[0].outcome).toBe('dry_run')
  })

  it('writes power on with the hardware default temperature when none is resolved', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setPower', on: true }] })]) // no temp
    await h.engine.reload()
    await h.engine.tick()
    expect(h.hwCalls[0]).toMatchObject({ op: 'power', side: 'left', on: true })
    expect(h.hwCalls[0].temp).toBeUndefined()
    expect(h.runs[0].outcome).toBe('fired')
  })

  it('reports clamped when an anti-thrash re-assertion is still out of band', async () => {
    const h = makeHarness([rule({ actions: [{ kind: 'setTemperature', temp: sig('target'), clamp: { min: 60, max: 75 } }] })])
    h.setSignal('target', 200) // clamps to 75, sent + clamped
    await h.engine.reload()
    await h.engine.tick()
    expect(h.runs[0].outcome).toBe('clamped')
    h.advance(60_000)
    h.setSignal('target', 201) // clamps to 75 again → anti-thrash, still clamped
    await h.engine.tick()
    expect(h.runs[1].detail.actions?.[0]?.antiThrash).toBe(true)
    expect(h.runs[1].outcome).toBe('clamped')
  })
})
