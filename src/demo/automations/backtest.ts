/**
 * Browser-side port of src/automation/backtest.ts `runBacktest`, reading the
 * synthetic signal functions instead of recorded series. The real module can't
 * be bundled client-side: it imports the timezone clock from signals.ts, which
 * pulls in the DAC monitor. Kept behaviourally in step with the original.
 */

import type { BacktestResult, BacktestRule } from '@/src/automation/backtest'
import { evaluateCondition } from '@/src/automation/evaluator'
import { evaluateExpr } from '@/src/automation/expressions'
import type { Action, Condition, Expr, Trigger } from '@/src/automation/types'
import { MINUTE } from '../util'
import { contextAt } from './simulate'
import { localClock, signalAt } from './signals'

const HW_MIN = 55
const HW_MAX = 110
const DEFAULT_CLAMP = { min: 60, max: 100 }

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

function firstSignalInExpr(e: Expr): { key: string, windowed: boolean } | null {
  switch (e.kind) {
    case 'signal':
      return { key: e.signal, windowed: false }
    case 'window':
      return { key: e.signal, windowed: true }
    case 'binary':
      return firstSignalInExpr(e.left) ?? firstSignalInExpr(e.right)
    case 'clamp':
      return firstSignalInExpr(e.value) ?? firstSignalInExpr(e.min) ?? firstSignalInExpr(e.max)
    default:
      return null
  }
}

function findPrimaryCompare(cond: Condition): { left: Expr, threshold: number | null } | null {
  switch (cond.kind) {
    case 'and':
    case 'or':
      for (const c of cond.conditions) {
        const found = findPrimaryCompare(c)
        if (found) return found
      }
      return null
    case 'not':
      return findPrimaryCompare(cond.condition)
    case 'compare':
      if (!firstSignalInExpr(cond.left)) return null
      return { left: cond.left, threshold: cond.right.kind === 'literal' ? cond.right.value : null }
    default:
      return null
  }
}

function findTimeWindow(cond: Condition): { startMin: number, endMin: number } | null {
  const toMin = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number)
    return h * 60 + m
  }
  switch (cond.kind) {
    case 'and':
    case 'or':
      for (const c of cond.conditions) {
        const r = findTimeWindow(c)
        if (r) return r
      }
      return null
    case 'not':
      return findTimeWindow(cond.condition)
    case 'timeBetween':
      return { startMin: toMin(cond.start), endMin: toMin(cond.end) }
    default:
      return null
  }
}

function edgeDelta(temp: Expr, nominalBase: number): number {
  if (temp.kind === 'binary' && (temp.op === '+' || temp.op === '-')) {
    const lit = temp.right.kind === 'literal' ? temp.right.value : temp.left.kind === 'literal' ? temp.left.value : null
    if (lit != null) return temp.op === '-' ? -lit : lit
  }
  if (temp.kind === 'literal') return temp.value - nominalBase
  return 0
}

const twoLayerClamp = (v: number, band: { min: number, max: number }) =>
  Math.min(Math.max(Math.min(Math.max(v, band.min), band.max), HW_MIN), HW_MAX)

function isInWindow(nowMin: number, w: { startMin: number, endMin: number }): boolean {
  if (w.startMin === w.endMin) return false
  if (w.startMin < w.endMin) return nowMin >= w.startMin && nowMin < w.endMin
  return nowMin >= w.startMin || nowMin < w.endMin
}

const round1 = (v: number) => Math.round(v * 10) / 10
const niceMax = (v: number) => Math.ceil(v / 100) * 100 || Math.ceil(v)

function triggerActive(trig: Trigger, t: number, state: { last?: number, seen: boolean, timeKey?: string }): boolean {
  if (trig.kind === 'tick') return true
  if (trig.kind === 'signalChange') {
    const v = signalAt(trig.signal, t)
    if (v === undefined) return false
    const active = state.seen && v !== state.last
    state.last = v
    state.seen = true
    return active
  }
  const { nowMinutes, dayOfWeek } = localClock(t)
  const [h, m] = trig.at.split(':').map(Number)
  if (nowMinutes !== h * 60 + m || (trig.days && !trig.days.includes(dayOfWeek))) return false
  const key = `${dayOfWeek}:${nowMinutes}`
  if (state.timeKey === key) return false
  state.timeKey = key
  return true
}

export function runDemoBacktest(rule: BacktestRule, startMs: number, endMs: number, stepMin = 2): BacktestResult {
  const stepMs = stepMin * MINUTE
  const setTemp = rule.actions.find(a => a.kind === 'setTemperature') as Extract<Action, { kind: 'setTemperature' }> | undefined
  const primaryCompare = findPrimaryCompare(rule.conditions)
  const timeWindow = findTimeWindow(rule.conditions)
  const clampBand = setTemp?.clamp ?? DEFAULT_CLAMP
  const tempSignal = setTemp ? firstSignalInExpr(setTemp.temp) : null
  const tempTracksLiveSignal = !!tempSignal
    && !tempSignal.key.endsWith('.currentTemperature')
    && !tempSignal.key.endsWith('.targetTemperature')
  const mode: 'policy' | 'edge' = tempTracksLiveSignal && !primaryCompare ? 'policy' : 'edge'

  const steps: number[] = []
  for (let t = startMs; t <= endMs; t += stepMs) steps.push(t)
  const clockMin = steps.map(t => localClock(t).nowMinutes)

  const fires: number[] = []
  const suppressed: number[] = []
  const setpoint: (number | null)[] = []
  const setpointRaw: (number | null)[] = []
  const primaryValues: (number | null)[] = []
  const avgValues: (number | null)[] = []
  const trigState: { last?: number, seen: boolean, timeKey?: string } = { seen: false }

  let lastFireMs: number | null = null
  const nominalBase = Math.round((clampBand.min + clampBand.max) / 2)
  const revertMin = setTemp?.durationSec ? Math.round(setTemp.durationSec / 60) : 0
  const revertSteps = Math.max(1, Math.round(revertMin / stepMin))
  const revertUntil: number[] = []
  const compareSig = primaryCompare ? firstSignalInExpr(primaryCompare.left) : null

  for (let i = 0; i < steps.length; i++) {
    const nowMs = steps[i]
    const ctx = contextAt(nowMs)

    if (primaryCompare) {
      primaryValues.push(compareSig ? signalAt(compareSig.key, nowMs) ?? null : null)
      avgValues.push(evaluateExpr(primaryCompare.left, ctx) ?? null)
    }
    else if (mode === 'policy' && tempSignal) {
      primaryValues.push(signalAt(tempSignal.key, nowMs) ?? null)
      avgValues.push(null)
    }
    else {
      primaryValues.push(null)
      avgValues.push(null)
    }

    let fired = false
    if (mode === 'edge' && triggerActive(rule.trigger, nowMs, trigState)) {
      if (evaluateCondition(rule.conditions, ctx) === true) {
        const cool = rule.cooldownMin != null && lastFireMs != null && nowMs - lastFireMs < rule.cooldownMin * MINUTE
        if (cool) {
          suppressed.push(i)
        }
        else {
          fires.push(i)
          fired = true
          lastFireMs = nowMs
          if (revertMin > 0) revertUntil.push(i + revertSteps)
        }
      }
    }

    if (!setTemp) {
      setpoint.push(null)
      setpointRaw.push(null)
      continue
    }
    if (mode === 'policy') {
      const inWindow = timeWindow ? isInWindow(ctx.nowMinutes, timeWindow) : true
      const raw = inWindow ? evaluateExpr(setTemp.temp, ctx) : undefined
      setpointRaw.push(raw === undefined ? null : round1(raw))
      setpoint.push(raw === undefined ? null : round1(twoLayerClamp(raw, clampBand)))
    }
    else {
      const active = revertMin > 0 ? revertUntil.some(end => i < end && i >= end - revertSteps) : fired
      const delta = edgeDelta(setTemp.temp, nominalBase)
      setpoint.push(active ? round1(twoLayerClamp(nominalBase + delta, clampBand)) : nominalBase)
      setpointRaw.push(null)
    }
  }

  const primarySig = primaryCompare ? compareSig : (mode === 'policy' && tempSignal ? tempSignal : null)
  const primaryUnit = primarySig?.key.includes('temperature') ? '°F' : ''
  const allPrimary = [
    ...primaryValues.filter((v): v is number => v != null),
    ...avgValues.filter((v): v is number => v != null),
    ...(primaryCompare?.threshold != null ? [primaryCompare.threshold] : []),
  ]
  const primaryAxis = primarySig && allPrimary.length
    ? { min: Math.min(0, ...allPrimary), max: niceMax(Math.max(...allPrimary)), unit: primaryUnit }
    : null
  const setNums = [...setpoint, ...setpointRaw].filter((v): v is number => v != null)
  const tempAxis = setNums.length ? { min: Math.floor(Math.min(...setNums) - 1), max: Math.ceil(Math.max(...setNums) + 1) } : null

  let clampHits = 0
  for (let i = 0; i < setpointRaw.length; i++) {
    const raw = setpointRaw[i]
    const c = setpoint[i]
    if (raw != null && c != null && Math.abs(raw - c) > 0.05) clampHits++
  }

  let netEffect: string | null = null
  if (setTemp && mode === 'edge') {
    const delta = edgeDelta(setTemp.temp, nominalBase)
    netEffect = `${delta >= 0 ? '+' : ''}${delta}°F · ${revertMin || 0}m`
  }
  const label = (key: string) => SIGNAL_LABELS[key] ?? key

  return {
    mode,
    stepMin,
    clockMin,
    primary: primarySig ? { key: primarySig.key, label: label(primarySig.key), values: primaryValues } : null,
    avg: compareSig?.windowed ? { key: compareSig.key, label: `avg ${label(compareSig.key)}`, values: avgValues } : null,
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
      setpointRange: setNums.length ? [Math.min(...setNums), Math.max(...setNums)] : null,
    },
  }
}
