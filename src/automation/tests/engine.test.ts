import { describe, expect, it } from 'vitest'
import { AutomationEngine, type AutomationEngineDeps } from '../engine'
import type { SignalSnapshot } from '../signals'
import type { Action, AutomationRule, Condition, DayOfWeek, Expr, RunOutcome, Trigger, Side } from '../types'

interface HwCall {
  op: 'temp' | 'power'
  side: Side
  temp?: number
  duration?: number
  on?: boolean
}

interface RunDetail {
  reason?: string
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
