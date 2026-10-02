/**
 * Replays each demo rule through the real engine evaluator over the synthetic
 * signal history, producing `automation_runs`-shaped rows. The run log the
 * Autopilot pages read is therefore what the rules would actually have done.
 */

import { evaluateCondition } from '@/src/automation/evaluator'
import { evaluateExpr, type EvalContext } from '@/src/automation/expressions'
import type { Action, Condition, RunOutcome, Side, Trigger, WindowFn } from '@/src/automation/types'
import type { WindowStore } from '@/src/automation/windows'
import { DAY, HOUR, MINUTE } from '../util'
import { inBed, localClock, signalAt } from './signals'

export interface DemoRule {
  id: number
  name: string
  enabled: boolean
  side: Side | null
  priority: number
  dryRun: boolean
  cooldownMin: number | null
  trigger: Trigger
  conditions: Condition
  actions: Action[]
  createdAt: Date
  updatedAt: Date
}

export interface DemoRun {
  automationId: number
  firedAt: Date
  outcome: RunOutcome
  detail: unknown
}

/** Window aggregates computed straight from the signal functions (1-min samples). */
export const signalWindows = {
  aggregate(fn: WindowFn, key: string, lastMin: number, nowMs: number): number | undefined {
    const values: number[] = []
    const end = Math.floor(nowMs / MINUTE) * MINUTE
    for (let t = end - (lastMin - 1) * MINUTE; t <= end; t += MINUTE) {
      const v = signalAt(key, t)
      if (v !== undefined) values.push(v)
    }
    if (fn === 'count') return values.length
    if (values.length === 0) return undefined
    switch (fn) {
      case 'avg':
        return values.reduce((a, b) => a + b, 0) / values.length
      case 'sum':
        return values.reduce((a, b) => a + b, 0)
      case 'min':
        return Math.min(...values)
      case 'max':
        return Math.max(...values)
    }
  },
} as unknown as WindowStore

export function contextAt(t: number): EvalContext {
  const clock = localClock(t)
  return { signal: key => signalAt(key, t), windows: signalWindows, nowMs: t, ...clock }
}

const HW_MIN = 55
const HW_MAX = 110
const round1 = (v: number) => Math.round(v * 10) / 10

/** Evaluation instants a rule's trigger produces in [fromMs, toMs]. */
function instants(trigger: Trigger, fromMs: number, toMs: number): number[] {
  const out: number[] = []
  if (trigger.kind === 'tick') {
    const step = Math.max(1, trigger.everyMin) * MINUTE
    for (let t = Math.ceil(fromMs / step) * step; t <= toMs; t += step) out.push(t + 2_000)
    return out
  }
  if (trigger.kind === 'timeOfDay') {
    const [h, m] = trigger.at.split(':').map(Number)
    const d = new Date(fromMs)
    d.setHours(0, 0, 0, 0)
    for (; d.getTime() <= toMs; d.setDate(d.getDate() + 1)) {
      const t = new Date(d)
      t.setHours(h, m, 0, 0)
      if (t.getTime() < fromMs || t.getTime() > toMs) continue
      if (trigger.days && !trigger.days.includes(localClock(t.getTime()).dayOfWeek)) continue
      out.push(t.getTime())
    }
    return out
  }
  let prev: number | undefined
  for (let t = Math.ceil(fromMs / MINUTE) * MINUTE; t <= toMs; t += MINUTE) {
    const v = signalAt(trigger.signal, t)
    if (v !== undefined && prev !== undefined && v !== prev) out.push(t)
    if (v !== undefined) prev = v
  }
  return out
}

function actionSides(action: Action, rule: DemoRule): Side[] {
  if (action.kind !== 'notify' && action.side) return [action.side]
  return rule.side ? [rule.side] : ['left', 'right']
}

/** Simulate a rule over [fromMs, toMs]; `warmupMs` of earlier evaluations seed cooldown state. */
function simulate(rule: DemoRule, fromMs: number, toMs: number, warmupMs: number): DemoRun[] {
  const out: DemoRun[] = []
  let lastFireMs: number | null = null
  // Last setpoint sent per side; a reverting action's setpoint lapses with it.
  const lastSent: Partial<Record<Side, { temp: number, until: number }>> = {}
  const poweredOff: Partial<Record<Side, boolean>> = {}

  for (const t of instants(rule.trigger, fromMs - warmupMs, toMs)) {
    for (const s of ['left', 'right'] as const) if (inBed(s, t)) poweredOff[s] = false
    const ctx = contextAt(t)
    const cond = evaluateCondition(rule.conditions, ctx)
    let outcome: RunOutcome
    let detail: unknown

    if (cond === undefined) {
      outcome = 'skipped'
      detail = { reason: 'condition-unknown' }
    }
    else if (!cond) {
      outcome = 'skipped'
      detail = { reason: 'condition-false' }
    }
    else if (rule.cooldownMin != null && lastFireMs != null && t - lastFireMs < rule.cooldownMin * MINUTE) {
      outcome = 'skipped'
      detail = { reason: 'cooldown' }
    }
    else {
      const results: Record<string, unknown>[] = []
      let clamped = false
      for (const action of rule.actions) {
        for (const side of actionSides(action, rule)) {
          if (action.kind === 'notify') {
            results.push({ kind: 'notify', notified: !rule.dryRun, dryRun: rule.dryRun })
            break
          }
          if (action.kind === 'setPower') {
            if (!action.on && poweredOff[side]) {
              results.push({ kind: 'setPower', side, skipped: 'off', on: false })
              continue
            }
            if (!action.on) poweredOff[side] = true
            results.push({ kind: 'setPower', side, on: action.on, sent: !rule.dryRun, dryRun: rule.dryRun })
            continue
          }
          const raw = evaluateExpr(action.temp, ctx)
          if (raw === undefined) {
            results.push({ kind: 'setTemperature', side, skipped: 'temp-unknown' })
            continue
          }
          const band = action.clamp ?? { min: 60, max: 100 }
          const temp = round1(Math.min(Math.max(Math.min(Math.max(raw, band.min), band.max), HW_MIN), HW_MAX))
          const wasClamped = Math.abs(temp - raw) > 0.05
          const prev = lastSent[side]
          if (prev && t < prev.until && Math.abs(prev.temp - temp) < 0.5) {
            results.push({ kind: 'setTemperature', side, antiThrash: true, temp })
            continue
          }
          lastSent[side] = { temp, until: action.durationSec ? t + action.durationSec * 1000 : Infinity }
          clamped ||= wasClamped
          results.push({ kind: 'setTemperature', side, temp, clamped: wasClamped, sent: !rule.dryRun, dryRun: rule.dryRun })
        }
      }
      const acted = results.some(r => r.sent || r.notified || r.dryRun)
      if (acted) lastFireMs = t
      outcome = !acted ? 'skipped' : rule.dryRun ? 'dry_run' : clamped ? 'clamped' : 'fired'
      detail = { actions: results }
    }

    if (t >= fromMs) out.push({ automationId: rule.id, firedAt: new Date(t), outcome, detail })
  }
  return out
}

const chunkCache = new Map<string, DemoRun[]>()
/** Today's runs so far per rule revision, extended incrementally each call. */
const todayCache = new Map<string, { until: number, runs: DemoRun[] }>()

function localMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Every run a rule would have logged in [fromMs, now]. Whole past days are
 * cached per rule revision; today is extended from where the last call ended.
 */
export function runsFor(rule: DemoRule, fromMs: number, now = Date.now()): DemoRun[] {
  const start = Math.max(fromMs, rule.createdAt.getTime())
  if (start > now) return []
  const out: DemoRun[] = []
  for (let day = localMidnight(start); day <= now; day = localMidnight(day + DAY + 2 * HOUR)) {
    const dayEnd = localMidnight(day + DAY + 2 * HOUR) - 1
    const key = `${rule.id}:${rule.updatedAt.getTime()}:${day}`
    let chunk: DemoRun[]
    if (dayEnd < now) {
      chunk = chunkCache.get(key) ?? simulate(rule, day, dayEnd, 3 * HOUR)
      chunkCache.set(key, chunk)
    }
    else {
      const prev = todayCache.get(key)
      const runs = prev
        ? [...prev.runs, ...simulate(rule, prev.until + 1, now, 3 * HOUR)]
        : simulate(rule, day, now, 3 * HOUR)
      todayCache.set(key, { until: now, runs })
      chunk = runs
    }
    for (const r of chunk) {
      const t = r.firedAt.getTime()
      if (t >= start && t <= now) out.push(r)
    }
  }
  return out
}
