/**
 * Backtest — replays an automation rule against REAL recorded signal history for
 * a chosen past night and reports what it would have done. This is the
 * transparency wedge: users see why a rule fires and what setpoint it produces
 * before it ever touches the bed.
 *
 * The replay reuses the engine's pure evaluation core (WindowStore for windowed
 * aggregates, evaluateCondition for the IF tree, evaluateExpr for action params)
 * over snapshots reconstructed at a fixed step. It never touches hardware or the
 * live engine — it is a deterministic function of (rule, history).
 *
 * Two render modes, matching how the two motivating examples differ:
 *   - 'policy' — the setpoint is a continuous function of a live signal
 *     (e.g. ambient + 3), re-asserted each step within a time window. Ambient is
 *     persisted, so the setpoint line is computed from real data and clamped.
 *   - 'edge'  — a threshold/aggregate crossing fires a one-shot delta with a
 *     revert window and cooldown. The compared signal (e.g. movement) is real;
 *     the setpoint is shown relative to a NOMINAL baseline because per-side
 *     target-temperature history is not persisted (device_state is live-only).
 */

import { MAX_TEMP, MIN_TEMP } from '@/src/hardware/types'
import { clockInTimezone, resolveSignal, type BaselineMap } from './signals'
import { createConditionStateStore, evaluateCondition } from './evaluator'
import { evaluateExpr, type EvalContext } from './expressions'
import { WindowStore } from './windows'
import {
  AUTOMATION_DEFAULT_USER_MAX,
  AUTOMATION_DEFAULT_USER_MIN,
  type Action,
  type Condition,
  type Expr,
  type Trigger,
} from './types'

/** A timestamped numeric sample (epoch ms). */
export interface Sample { t: number, v: number }

/** Rule shape the backtest replays (the engine AST, side already resolved). */
export interface BacktestRule {
  side: 'left' | 'right' | null
  cooldownMin: number | null
  trigger: Trigger
  conditions: Condition
  actions: Action[]
}

export interface BacktestInput {
  rule: BacktestRule
  timezone: string
  /** Inclusive window the replay walks, epoch ms. */
  startMs: number
  endMs: number
  /** Step size in minutes (defaults to 1, matching the engine's resolution). */
  stepMin?: number
  /** Historical series keyed by concrete signal key (e.g. `left.movement`). */
  series: Record<string, Sample[]>
  /** Per-side vitals baselines (mean/SD) backing `{side}.{vital}.zscore`. */
  baselines?: BaselineMap
}

export interface BacktestSeries {
  key: string
  label: string
  /** One value per replay step; null where no fresh sample was available. */
  values: (number | null)[]
}

export interface BacktestResult {
  mode: 'policy' | 'edge'
  stepMin: number
  /** Minutes-since-local-midnight for each step (for axis ticks). */
  clockMin: number[]
  /** Raw trace of the primary compared signal. */
  primary: BacktestSeries | null
  /** Windowed-aggregate trace (the value actually compared), edge mode. */
  avg: BacktestSeries | null
  threshold: number | null
  /** Resulting setpoint after the two-layer clamp, per step. */
  setpoint: (number | null)[]
  /** Pre-clamp setpoint (policy mode ghost line). */
  setpointRaw: (number | null)[] | null
  clamp: { min: number, max: number } | null
  /** Time-of-day window for the shaded region, minutes since midnight. */
  timeWindow: { startMin: number, endMin: number } | null
  fires: number[]
  suppressed: number[]
  primaryAxis: { min: number, max: number, unit: string } | null
  tempAxis: { min: number, max: number } | null
  summary: {
    wouldFire: number
    suppressed: number
    clampHits: number
    label: string
    netEffect: string | null
    setpointRange: [number, number] | null
  }
}

/** Last sample at or before `atMs`, within a staleness bound. undefined if none. */
function sampleAt(buf: Sample[] | undefined, atMs: number, maxAgeMs: number): number | undefined {
  if (!buf || buf.length === 0) return undefined
  let best: Sample | undefined
  for (const s of buf) {
    if (s.t <= atMs && (!best || s.t > best.t)) best = s
  }
  if (!best) return undefined
  return atMs - best.t <= maxAgeMs ? best.v : undefined
}

/** First signal key referenced anywhere in an expression. */
function firstSignalInExpr(e: Expr): { key: string, windowed: boolean, fn?: string, lastMin?: number } | null {
  switch (e.kind) {
    case 'signal':
      return { key: e.signal, windowed: false }
    case 'window':
      return { key: e.signal, windowed: true, fn: e.fn, lastMin: e.lastMin }
    case 'binary':
      return firstSignalInExpr(e.left) ?? firstSignalInExpr(e.right)
    case 'clamp':
      return firstSignalInExpr(e.value) ?? firstSignalInExpr(e.min) ?? firstSignalInExpr(e.max)
    default:
      return null
  }
}

/** Find the first comparison that drives the rule (for the chart's primary trace). */
function findPrimaryCompare(cond: Condition):
  { left: Expr, op: string, threshold: number | null } | null {
  switch (cond.kind) {
    case 'and':
    case 'or': {
      for (const c of cond.conditions) {
        const found = findPrimaryCompare(c)
        if (found) return found
      }
      return null
    }
    case 'not':
      return findPrimaryCompare(cond.condition)
    case 'sustained':
      return findPrimaryCompare(cond.condition)
    case 'compare': {
      // Prefer a comparison whose left side references a signal.
      const sig = firstSignalInExpr(cond.left)
      if (!sig) return null
      const threshold = cond.right.kind === 'literal' ? cond.right.value : null
      return { left: cond.left, op: cond.op, threshold }
    }
    default:
      return null
  }
}

/** Extract the time-of-day window from the trigger/condition, if any. */
function findTimeWindow(trigger: Trigger, cond: Condition): { startMin: number, endMin: number } | null {
  const toMin = (hhmm: string): number => {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
  }
  const walk = (c: Condition): { startMin: number, endMin: number } | null => {
    switch (c.kind) {
      case 'and':
      case 'or':
        for (const x of c.conditions) {
          const r = walk(x)
          if (r) return r
        }
        return null
      case 'not':
        return walk(c.condition)
      case 'sustained':
        return walk(c.condition)
      case 'timeBetween':
        return { startMin: toMin(c.start), endMin: toMin(c.end) }
      default:
        return null
    }
  }
  return walk(cond)
}

const SIGNAL_LABELS: Record<string, string> = {
  'ambient.temperature': 'Ambient temp',
  'ambient.humidity': 'Ambient humidity',
  'left.movement': 'Movement (L)',
  'right.movement': 'Movement (R)',
  'left.heartRate': 'Heart rate (L)',
  'right.heartRate': 'Heart rate (R)',
  'left.hrv': 'HRV (L)',
  'right.hrv': 'HRV (R)',
  'left.breathingRate': 'Breathing (L)',
  'right.breathingRate': 'Breathing (R)',
}
function signalLabel(key: string): string {
  return SIGNAL_LABELS[key] ?? key
}

/**
 * Replay a rule over recorded history. Pure: deterministic in its inputs, no
 * hardware, DB, or clock access beyond the injected timezone.
 */
export function runBacktest(input: BacktestInput): BacktestResult {
  const stepMin = input.stepMin ?? 1
  const stepMs = stepMin * 60_000
  const { rule, series, timezone } = input

  // ---- introspect the rule for charting --------------------------------
  const setTemp = rule.actions.find(a => a.kind === 'setTemperature') as
    Extract<Action, { kind: 'setTemperature' }> | undefined
  const primaryCompare = findPrimaryCompare(rule.conditions)
  const timeWindow = findTimeWindow(rule.trigger, rule.conditions)
  const clampBand = setTemp?.clamp ?? { min: AUTOMATION_DEFAULT_USER_MIN, max: AUTOMATION_DEFAULT_USER_MAX }

  // Policy mode: a setTemperature whose expression tracks a non-target signal
  // continuously, with no driving threshold comparison (time-window only).
  const tempSignal = setTemp ? firstSignalInExpr(setTemp.temp) : null
  const tempTracksLiveSignal = !!tempSignal
    && !tempSignal.key.endsWith('.currentTemperature')
    && !tempSignal.key.endsWith('.targetTemperature')
  const mode: 'policy' | 'edge' = tempTracksLiveSignal && !primaryCompare ? 'policy' : 'edge'

  // ---- build the step grid --------------------------------------------
  const steps: number[] = []
  for (let t = input.startMs; t <= input.endMs; t += stepMs) steps.push(t)
  const clockMin = steps.map(t => clockInTimezone(timezone, new Date(t)).nowMinutes)

  // Which signals are windowed (must be fed to the WindowStore each step).
  const windows = new WindowStore()
  const maxAgeMs = 15 * 60_000 // a sample older than 15 min is "stale"

  const fires: number[] = []
  const suppressed: number[] = []
  const setpoint: (number | null)[] = []
  const setpointRaw: (number | null)[] = []
  const primaryValues: (number | null)[] = []
  const avgValues: (number | null)[] = []

  // Latch/debounce state persists across steps, exactly as in the live engine.
  const condState = createConditionStateStore()

  let lastFireMs: number | null = null
  let lastTrigVal: number | undefined
  let lastTrigSeen = false
  let lastTimeKey: string | undefined

  // Edge-mode nominal baseline (per-side target history is not persisted).
  const nominalBase = Math.round((clampBand.min + clampBand.max) / 2)
  const revertMin = setTemp?.durationSec ? Math.round(setTemp.durationSec / 60) : 0
  // active revert windows: list of [startStep, endStep)
  const revertUntil: number[] = []

  for (let i = 0; i < steps.length; i++) {
    const nowMs = steps[i]
    const { nowMinutes, dayOfWeek } = clockInTimezone(timezone, new Date(nowMs))

    const sampleSnap = (key: string): number | undefined => sampleAt(series[key], nowMs, maxAgeMs)
    // z-score signals derive from the raw vital series plus the baselines.
    const snap = (key: string): number | undefined => resolveSignal(sampleSnap, key, input.baselines)

    // Feed window buffers for any windowed signal referenced by the rule.
    if (primaryCompare) {
      const sig = firstSignalInExpr(primaryCompare.left)
      if (sig?.windowed) {
        const v = snap(sig.key)
        if (typeof v === 'number') windows.record(sig.key, v, nowMs)
      }
    }

    const ctx: EvalContext = {
      signal: snap,
      windows,
      nowMs,
      nowMinutes,
      dayOfWeek,
      condState,
    }

    // primary + avg traces
    if (primaryCompare) {
      const sig = firstSignalInExpr(primaryCompare.left)
      primaryValues.push(sig ? snap(sig.key) ?? null : null)
      const v = evaluateExpr(primaryCompare.left, ctx)
      avgValues.push(v ?? null)
    }
    else if (mode === 'policy' && tempSignal) {
      primaryValues.push(snap(tempSignal.key) ?? null)
      avgValues.push(null)
    }
    else {
      primaryValues.push(null)
      avgValues.push(null)
    }

    // ---- replay the trigger + condition + gates ----------------------
    // Policy mode re-asserts a setpoint continuously; it has no discrete
    // fires, so only edge mode records fire/suppress markers.
    let fired = false
    if (mode === 'edge') {
      const trig = rule.trigger
      let triggerActive = false
      if (trig.kind === 'tick') {
        triggerActive = true // every step is a tick at this resolution
      }
      else if (trig.kind === 'signalChange') {
        const v = ctx.signal(trig.signal)
        if (v !== undefined) {
          triggerActive = lastTrigSeen && v !== lastTrigVal
          lastTrigVal = v
          lastTrigSeen = true
        }
      }
      else {
        const [h, m] = trig.at.split(':').map(Number)
        const atMin = h * 60 + m
        if (nowMinutes === atMin && (!trig.days || trig.days.includes(dayOfWeek))) {
          const key = `${dayOfWeek}:${atMin}`
          if (lastTimeKey !== key) {
            triggerActive = true
            lastTimeKey = key
          }
        }
      }

      if (triggerActive) {
        const cond = evaluateCondition(rule.conditions, ctx)
        if (cond === true) {
          const cool = rule.cooldownMin != null && lastFireMs != null
            && nowMs - lastFireMs < rule.cooldownMin * 60_000
          if (cool) {
            suppressed.push(i)
          }
          else {
            fires.push(i)
            fired = true
            lastFireMs = nowMs
            if (revertMin > 0) revertUntil.push(i + Math.max(1, Math.round(revertMin / stepMin)))
          }
        }
      }
    }

    // ---- resulting setpoint ------------------------------------------
    if (!setTemp) {
      setpoint.push(null)
      setpointRaw.push(null)
      continue
    }

    if (mode === 'policy') {
      // Continuous: setpoint = clamp(expr(signals)) whenever in the time window.
      const inWindow = timeWindow ? isInWindow(nowMinutes, timeWindow) : true
      const raw = inWindow ? evaluateExpr(setTemp.temp, ctx) : undefined
      if (raw === undefined) {
        setpoint.push(null)
        setpointRaw.push(null)
      }
      else {
        setpointRaw.push(round1(raw))
        setpoint.push(round1(twoLayerClamp(raw, clampBand)))
      }
    }
    else {
      // Edge: nominal baseline, shifted by the action delta during revert windows.
      const active = revertMin > 0
        ? revertUntil.some(end => i < end && i >= end - Math.max(1, Math.round(revertMin / stepMin)))
        : fired
      const delta = edgeDelta(setTemp.temp, nominalBase)
      setpoint.push(active ? round1(twoLayerClamp(nominalBase + delta, clampBand)) : nominalBase)
      setpointRaw.push(null)
    }
  }

  // ---- axes + summary --------------------------------------------------
  const compareSig = primaryCompare ? firstSignalInExpr(primaryCompare.left) : null
  const primarySig = primaryCompare
    ? compareSig
    : (mode === 'policy' && tempSignal ? tempSignal : null)
  const primaryUnit = primarySig?.key.includes('movement') ? '' : primarySig?.key.includes('temperature') ? '°F' : ''
  const primaryNums = primaryValues.filter((v): v is number => v != null)
  const avgNums = avgValues.filter((v): v is number => v != null)
  const allPrimary = [...primaryNums, ...avgNums, ...(primaryCompare?.threshold != null ? [primaryCompare.threshold] : [])]
  const primaryAxis = primarySig && allPrimary.length
    ? { min: Math.min(0, ...allPrimary), max: niceMax(Math.max(...allPrimary)), unit: primaryUnit }
    : null

  const setNums = [...setpoint, ...(setpointRaw ?? [])].filter((v): v is number => v != null)
  const tempAxis = setNums.length
    ? { min: Math.floor(Math.min(...setNums) - 1), max: Math.ceil(Math.max(...setNums) + 1) }
    : null

  let clampHits = 0
  for (let i = 0; i < setpointRaw.length; i++) {
    const raw = setpointRaw[i]
    const c = setpoint[i]
    if (raw != null && c != null && Math.abs(raw - c) > 0.05) clampHits++
  }

  // Range reflects the actual (clamped) setpoint only — not the pre-clamp ghost,
  // which `setNums` includes for axis fitting. Including raw here would report a
  // span wider than the clamp band ever allowed.
  const clampedNums = setpoint.filter((v): v is number => v != null)
  const setRange = clampedNums.length ? [Math.min(...clampedNums), Math.max(...clampedNums)] as [number, number] : null

  let netEffect: string | null = null
  if (setTemp && mode === 'edge') {
    const delta = edgeDelta(setTemp.temp, nominalBase)
    netEffect = `${delta >= 0 ? '+' : ''}${delta}°F · ${revertMin || 0}m`
  }

  return {
    mode,
    stepMin,
    clockMin,
    primary: primarySig ? { key: primarySig.key, label: signalLabel(primarySig.key), values: primaryValues } : null,
    avg: compareSig?.windowed
      ? { key: compareSig.key, label: `avg ${signalLabel(compareSig.key)}`, values: avgValues }
      : null,
    threshold: primaryCompare?.threshold ?? null,
    setpoint,
    setpointRaw: mode === 'policy' ? setpointRaw : null,
    clamp: clampBand,
    timeWindow,
    fires,
    suppressed,
    primaryAxis,
    tempAxis,
    summary: {
      wouldFire: fires.length,
      suppressed: suppressed.length,
      clampHits,
      label: mode === 'policy' ? 'Continuous' : 'Edge-triggered',
      netEffect,
      setpointRange: setRange,
    },
  }
}

/** Approximate the constant delta of an edge action's temp expr (e.g. current − 2 → −2). */
function edgeDelta(temp: Expr, nominalBase: number): number {
  if (temp.kind === 'binary' && (temp.op === '+' || temp.op === '-')) {
    const lit = temp.right.kind === 'literal'
      ? temp.right.value
      : temp.left.kind === 'literal' ? temp.left.value : null
    if (lit != null) return temp.op === '-' ? -lit : lit
  }
  if (temp.kind === 'literal') return temp.value - nominalBase
  return 0
}

function twoLayerClamp(v: number, band: { min: number, max: number }): number {
  const l1 = Math.min(Math.max(v, band.min), band.max)
  return Math.min(Math.max(l1, MIN_TEMP), MAX_TEMP)
}

function isInWindow(nowMin: number, w: { startMin: number, endMin: number }): boolean {
  if (w.startMin === w.endMin) return false
  if (w.startMin < w.endMin) return nowMin >= w.startMin && nowMin < w.endMin
  return nowMin >= w.startMin || nowMin < w.endMin
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
function niceMax(v: number): number {
  return Math.ceil(v / 100) * 100 || Math.ceil(v)
}
