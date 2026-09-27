/** Historical replay on a one-minute evaluation grid; chart sampling is separate.
 * Runtime history (manual overrides, run-once sessions, other rules and hardware
 * acknowledgements) is unavailable, so this estimates eligible rule actions.
 */

import { DEFAULT_HEATING_DURATION, MAX_TEMP, MIN_TEMP, TEMP_NEUTRAL } from '@/src/hardware/types'
import { clockInTimezone, collectWindowSignals } from './signals'
import { evaluateCondition } from './evaluator'
import { evaluateExpr, type EvalContext } from './expressions'
import { WindowStore } from './windows'
import { signalFreshnessMs } from './freshness'
import {
  AUTOMATION_DEFAULT_USER_MAX,
  AUTOMATION_DEFAULT_USER_MIN,
  type Action,
  type AutomationRule,
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
  /** Chart sampling interval in minutes. Evaluation always runs every minute. */
  stepMin?: number
  /** Historical series keyed by concrete signal key (e.g. `left.movement`). */
  series: Record<string, Sample[]>
}

export interface BacktestSeries {
  key: string
  label: string
  /** One value per chart sample; null where no fresh sample was available. */
  values: (number | null)[]
}

export interface BacktestResult {
  mode: 'policy' | 'edge'
  limitations: string[]
  nominalTargetF: number
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
function findTimeWindow(cond: Condition): { startMin: number, endMin: number } | null {
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
  if (!Number.isFinite(stepMin) || stepMin <= 0) throw new Error('stepMin must be positive')
  if (!Number.isFinite(input.startMs) || !Number.isFinite(input.endMs) || input.endMs < input.startMs) {
    throw new Error('Replay requires a finite chronological time range')
  }
  const stepMs = 60_000
  const { rule, series, timezone } = input

  // ---- introspect the rule for charting --------------------------------
  const setTemp = rule.actions.find(a => a.kind === 'setTemperature') as
    Extract<Action, { kind: 'setTemperature' }> | undefined
  const primaryCompare = findPrimaryCompare(rule.conditions)
  const timeWindow = findTimeWindow(rule.conditions)
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
  const windowKeys = collectWindowSignals([{ ...rule, enabled: true } as AutomationRule])

  const fires: number[] = []
  const suppressed: number[] = []
  const setpoint: (number | null)[] = []
  const setpointRaw: (number | null)[] = []
  const primaryValues: (number | null)[] = []
  const avgValues: (number | null)[] = []

  let lastFireMs: number | null = null
  let lastTrigVal: number | undefined
  let lastTrigSeen = false
  let lastTimeKey: string | undefined

  const nominalBase = Math.round((clampBand.min + clampBand.max) / 2)
  let target: number | null = null
  let rawTarget: number | null = null
  let expiresMs: number | null = null
  let lastTickMs = -Infinity
  let clampHits = 0
  let totalFires = 0
  let totalSuppressed = 0

  for (let i = 0; i < steps.length; i++) {
    const nowMs = steps[i]
    const clock = clockInTimezone(timezone, new Date(nowMs))
    if (expiresMs != null && nowMs >= expiresMs) {
      target = TEMP_NEUTRAL
      rawTarget = TEMP_NEUTRAL
      expiresMs = null
    }
    const snap = (key: string): number | undefined => {
      const value = sampleAt(series[key], nowMs, signalFreshnessMs(key))
      if (value !== undefined) return value
      // Only the target can be simulated. The measured water temperature is
      // not the target and cannot be inferred from a thermostat command.
      if (key.endsWith('.targetTemperature')) {
        const targetSide = setTemp?.side ?? rule.side
        return targetSide == null || key === `${targetSide}.targetTemperature` ? target ?? nominalBase : nominalBase
      }
      return undefined
    }
    for (const key of windowKeys) {
      const value = snap(key)
      if (value !== undefined) windows.record(key, value, nowMs)
    }
    const ctx: EvalContext = { signal: snap, windows, nowMs, ...clock }
    const sig = primaryCompare ? firstSignalInExpr(primaryCompare.left) : tempSignal
    primaryValues.push(sig ? snap(sig.key) ?? null : null)
    avgValues.push(primaryCompare ? evaluateExpr(primaryCompare.left, ctx) ?? null : null)

    const trig = rule.trigger
    let triggerActive = false
    if (trig.kind === 'tick') {
      triggerActive = nowMs - lastTickMs >= trig.everyMin * 60_000
      if (triggerActive) lastTickMs = nowMs
    }
    else if (trig.kind === 'signalChange') {
      const value = snap(trig.signal)
      if (value !== undefined) {
        triggerActive = lastTrigSeen && value !== lastTrigVal
        lastTrigSeen = true
        lastTrigVal = value
      }
    }
    else {
      const [h, m] = trig.at.split(':').map(Number)
      const atMin = h * 60 + m
      const key = `${clock.dateKey}:${atMin}`
      if ((!trig.days || trig.days.includes(clock.dayOfWeek))
        && clock.nowMinutes >= atMin && clock.nowMinutes <= atMin + 10
        && key !== lastTimeKey) {
        triggerActive = true
        lastTimeKey = key
      }
    }
    if (triggerActive && evaluateCondition(rule.conditions, ctx) === true) {
      if (rule.cooldownMin != null && lastFireMs != null
        && nowMs - lastFireMs < rule.cooldownMin * 60_000) {
        suppressed.push(i)
        totalSuppressed++
      }
      else {
        let acted = false
        // Chart the first temperature action; disclose multi-action limits.
        for (const action of rule.actions) {
          if (action.kind === 'notify') acted = true
          else if (action.kind === 'setTemperature') {
            const raw = evaluateExpr(action.temp, ctx)
            if (raw === undefined || !Number.isFinite(raw)) continue
            acted = true
            if (action === setTemp) {
              const clamped = twoLayerClamp(raw, clampBand)
              if (clamped !== raw) clampHits++
              target = clamped
              rawTarget = raw
              expiresMs = nowMs + (action.durationSec ?? DEFAULT_HEATING_DURATION) * 1000
            }
          }
          else if (!action.on || !action.temp || evaluateExpr(action.temp, ctx) !== undefined) {
            acted = true
          }
        }
        if (acted) {
          fires.push(i)
          totalFires++
          lastFireMs = nowMs
        }
      }
    }
    setpoint.push(target == null ? null : round1(target))
    setpointRaw.push(rawTarget == null ? null : round1(rawTarget))
  }

  // Downsample only presentation. Markers map into chart buckets while counts
  // retain all one-minute decisions (including multiple events in a bucket).
  const sampleIndices = steps.map((_, i) => i).filter(i => i === 0 || Math.floor(i / stepMin) !== Math.floor((i - 1) / stepMin))
  const sampled = <T>(values: T[]): T[] => sampleIndices.map(i => values[i])
  const markerIndex = (i: number): number => {
    let index = 0
    while (index + 1 < sampleIndices.length && sampleIndices[index + 1] <= i) index++
    return index
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

  const actualSetpoints = setpoint.filter((v): v is number => v != null)
  const setRange = actualSetpoints.length
    ? [Math.min(...actualSetpoints), Math.max(...actualSetpoints)] as [number, number]
    : null
  const netEffect = setTemp
    ? `Target persists; returns to ${TEMP_NEUTRAL}°F after ${(setTemp.durationSec ?? DEFAULT_HEATING_DURATION) / 60}m`
    : null

  return {
    mode,
    limitations: [
      `Missing target history starts at a nominal ${nominalBase}°F; measured current temperature is never inferred.`,
      'Estimates eligible actions, not hardware writes: manual overrides, run-once sessions, competing rules, anti-thrash and runaway gates are not reconstructed.',
      'Windows and trigger state start at the replay boundary; earlier runtime state is unavailable.',
      ...(rule.actions.filter(a => a.kind !== 'notify').length > 1 || rule.actions.some(a => a.kind === 'setPower')
        ? ['The temperature chart shows only the first setTemperature action; power state and other action targets are not simulated.']
        : []),
    ],
    nominalTargetF: nominalBase,
    stepMin,
    clockMin: sampled(clockMin),
    primary: primarySig ? { key: primarySig.key, label: signalLabel(primarySig.key), values: sampled(primaryValues) } : null,
    avg: compareSig?.windowed
      ? { key: compareSig.key, label: `avg ${signalLabel(compareSig.key)}`, values: sampled(avgValues) }
      : null,
    threshold: primaryCompare?.threshold ?? null,
    setpoint: sampled(setpoint),
    setpointRaw: mode === 'policy' ? sampled(setpointRaw) : null,
    clamp: clampBand,
    timeWindow,
    fires: fires.map(markerIndex),
    suppressed: suppressed.map(markerIndex),
    primaryAxis,
    tempAxis,
    summary: {
      wouldFire: totalFires,
      suppressed: totalSuppressed,
      clampHits,
      label: 'Eligible actions',
      netEffect,
      setpointRange: setRange,
    },
  }
}

function twoLayerClamp(v: number, band: { min: number, max: number }): number {
  const l1 = Math.min(Math.max(v, band.min), band.max)
  return Math.min(Math.max(l1, MIN_TEMP), MAX_TEMP)
}

function round1(v: number): number {
  return Math.round(v * 10) / 10
}
function niceMax(v: number): number {
  return Math.ceil(v / 100) * 100 || Math.ceil(v)
}
