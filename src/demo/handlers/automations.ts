import { bucketRuns, classifyRun, collapseRuns, conditionTimeWindow, inTimeWindow } from '@/src/automation/activity'
import type { BacktestRule } from '@/src/automation/backtest'
import type { Action, Condition, Expr } from '@/src/automation/types'
import { runDemoBacktest } from '../automations/backtest'
import { capZones, localClock, recentSessions, sessionById, sessionId, signalAt, type Session } from '../automations/signals'
import { runsFor, type DemoRule, type DemoRun } from '../automations/simulate'
import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, HOUR, MINUTE, startOfDay } from '../util'
import { getDemoDeviceStatus } from './device'

type Side = 'left' | 'right'
type BacktestSummary = RouterOutputs['automations']['backtestRange']

const now = () => Date.now()
const seededAt = new Date(now() - 30 * DAY)

const cur = (side: Side): Expr => ({ kind: 'signal', signal: `${side}.currentTemperature` })

let nextId = 1
function seed(rule: Omit<DemoRule, 'id' | 'createdAt' | 'updatedAt'>): DemoRule {
  return { ...rule, id: nextId++, createdAt: seededAt, updatedAt: seededAt }
}

const rules = new Map<number, DemoRule>([
  seed({
    name: 'Cool when restless',
    enabled: true,
    side: 'left',
    priority: 3,
    dryRun: false,
    cooldownMin: 30,
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [
      { kind: 'compare', op: '>', left: { kind: 'window', fn: 'avg', signal: 'left.movement', lastMin: 10 }, right: { kind: 'literal', value: 250 } },
      { kind: 'timeBetween', start: '23:00', end: '06:00' },
    ] },
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '-', left: cur('left'), right: { kind: 'literal', value: 2 } }, clamp: { min: 60, max: 75 }, durationSec: 1200 }],
  }),
  seed({
    name: 'Warm up when the surface runs cool',
    enabled: true,
    side: 'right',
    priority: 2,
    dryRun: false,
    cooldownMin: 60,
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [
      { kind: 'compare', op: '<', left: { kind: 'signal', signal: 'right.surfaceTemp' }, right: { kind: 'literal', value: 85.6 } },
      { kind: 'timeBetween', start: '23:00', end: '07:00' },
      { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'right.heartRate' }, right: { kind: 'literal', value: 0 } },
    ] },
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: cur('right'), right: { kind: 'literal', value: 2 } }, clamp: { min: 70, max: 88 }, durationSec: 1800 }],
  }),
  seed({
    name: 'Off when bed is empty',
    enabled: true,
    side: 'right',
    priority: 2,
    dryRun: false,
    cooldownMin: 120,
    trigger: { kind: 'tick', everyMin: 5 },
    conditions: { kind: 'and', conditions: [
      { kind: 'compare', op: '<', left: { kind: 'window', fn: 'max', signal: 'right.cap.mean', lastMin: 20 }, right: { kind: 'literal', value: 19.5 } },
      { kind: 'timeBetween', start: '07:30', end: '12:00' },
    ] },
    actions: [{ kind: 'setPower', on: false }],
  }),
  seed({
    name: 'Match the room',
    enabled: true,
    side: null,
    priority: 1,
    dryRun: true,
    cooldownMin: null,
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [{ kind: 'timeBetween', start: '22:00', end: '07:00' }] },
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '+', left: { kind: 'signal', signal: 'ambient.temperature' }, right: { kind: 'literal', value: 1 } }, clamp: { min: 62, max: 70 } }],
  }),
  seed({
    name: 'Low water heads-up',
    enabled: true,
    side: null,
    priority: 0,
    dryRun: false,
    cooldownMin: null,
    trigger: { kind: 'signalChange', signal: 'water.low' },
    conditions: { kind: 'and', conditions: [{ kind: 'compare', op: '==', left: { kind: 'signal', signal: 'water.low' }, right: { kind: 'literal', value: 1 } }] },
    actions: [{ kind: 'notify', message: 'Water tank is low — top it up before bed' }],
  }),
  seed({
    name: 'Humid night guard',
    enabled: false,
    side: 'left',
    priority: 0,
    dryRun: true,
    cooldownMin: 45,
    trigger: { kind: 'tick', everyMin: 1 },
    conditions: { kind: 'and', conditions: [
      { kind: 'compare', op: '>', left: { kind: 'signal', signal: 'ambient.humidity' }, right: { kind: 'literal', value: 55 } },
      { kind: 'timeBetween', start: '22:00', end: '07:00' },
    ] },
    actions: [{ kind: 'setTemperature', temp: { kind: 'binary', op: '-', left: cur('left'), right: { kind: 'literal', value: 1 } }, clamp: { min: 60, max: 75 } }],
  }),
].map(r => [r.id, r]))

// The seeded disabled rule was switched off a week ago, so its history stops there.
const offSince = new Map<number, number>([[6, now() - 7 * DAY]])
let globalEnabled = true
let globalOffSince: number | null = null

function ordered(): DemoRule[] {
  return [...rules.values()].sort((a, b) => b.priority - a.priority || a.id - b.id)
}

function getRule(id: number): DemoRule {
  const rule = rules.get(id)
  if (!rule) throw new Error(`Automation ${id} not found`)
  return rule
}

function toOutput(rule: DemoRule) {
  return { ...rule }
}

/** Runs the engine would have logged, minus time spent disabled or kill-switched. */
function loggedRuns(rule: DemoRule, fromMs: number): DemoRun[] {
  const cutoff = Math.min(rule.enabled ? Infinity : offSince.get(rule.id) ?? -Infinity, globalOffSince ?? Infinity)
  return runsFor(rule, fromMs).filter(r => r.firedAt.getTime() < cutoff)
}

function update(id: number, patch: Partial<DemoRule>): DemoRule {
  const rule = getRule(id)
  if (patch.enabled === false && rule.enabled) offSince.set(id, now())
  const next = { ...rule, ...patch, updatedAt: new Date() }
  rules.set(id, next)
  return next
}

// ---------------------------------------------------------------------------
// Nights
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function nightLabel(s: Session, i: number) {
  const d = new Date(s.evening)
  return { label: i === 0 ? 'Last night' : WEEKDAYS[d.getDay()], date: `${MONTHS[d.getMonth()]} ${d.getDate()}` }
}

function resolveNight(side: Side, id?: number) {
  const latest = recentSessions(side, 1)[0]
  const picked = id != null ? sessionById(side, id) : null
  const s = picked && picked.leftMs <= now() ? picked : latest
  if (!s) return null
  return { session: s, ...nightLabel(s, s === latest || sessionId(s) === sessionId(latest) ? 0 : 1) }
}

function backtestNights(rule: BacktestRule, limit: number): BacktestSummary {
  const sides: Side[] = rule.side ? [rule.side] : ['left', 'right']
  let nights = 0
  let wouldFire = 0
  let peak: number | null = null
  let low: number | null = null
  let threshold: number | null = null
  for (const side of sides) {
    const sessions = recentSessions(side, limit)
    nights = Math.max(nights, sessions.length)
    for (const s of sessions) {
      const result = runDemoBacktest({ ...rule, side }, s.enteredMs, s.leftMs, 2)
      wouldFire += result.summary.wouldFire
      threshold ??= result.threshold
      for (const v of (result.avg ?? result.primary)?.values ?? []) {
        if (v == null) continue
        if (peak == null || v > peak) peak = v
        if (low == null || v < low) low = v
      }
    }
  }
  return { nights, wouldFire, peak, low, threshold }
}

const summaryCache = new Map<string, BacktestSummary>()

// ---------------------------------------------------------------------------
// Live control (shared with the fake device)
// ---------------------------------------------------------------------------

const holdStarts = new Map<string, number>()

function currentHold(side: Side) {
  const control = getDemoDeviceStatus('F').temperatureControl?.[side]
  if (!control || control.source !== 'manual' || control.holdUntil == null || control.holdUntil <= now() || control.targetTemperature == null) return null
  const key = `${side}:${control.holdUntil}`
  if (!holdStarts.has(key)) holdStarts.set(key, now())
  return { side, temperature: control.targetTemperature, startedAt: holdStarts.get(key) ?? now(), expiresAt: control.holdUntil }
}

function conditionSignals(c: Condition): string[] {
  const out = new Set<string>()
  const expr = (e: Expr): void => {
    if (e.kind === 'signal' || e.kind === 'window') out.add(e.signal)
    else if (e.kind === 'binary') {
      expr(e.left)
      expr(e.right)
    }
    else if (e.kind === 'clamp') {
      expr(e.value)
      expr(e.min)
      expr(e.max)
    }
  }
  const walk = (x: Condition): void => {
    if (x.kind === 'and' || x.kind === 'or') x.conditions.forEach(walk)
    else if (x.kind === 'not') walk(x.condition)
    else if (x.kind === 'compare') {
      expr(x.left)
      expr(x.right)
    }
    else if (x.kind === 'between') {
      expr(x.subject)
      expr(x.min)
      expr(x.max)
    }
  }
  walk(c)
  return [...out]
}

/** Live read: device-backed signals come from the fake pod, the rest from history. */
function liveSignal(key: string): number | null {
  const m = /^(left|right)\.(currentTemperature|targetTemperature)$/.exec(key)
  if (m) {
    const status = getDemoDeviceStatus('F')
    const side = m[1] === 'left' ? status.leftSide : status.rightSide
    return m[2] === 'currentTemperature' ? side.currentTemperature : side.targetTemperature
  }
  return signalAt(key, now()) ?? null
}

function runSummary(detail: unknown): { reason: string | null, sent: boolean } {
  const d = (detail ?? {}) as { reason?: unknown, actions?: Array<{ sent?: unknown }> }
  return {
    reason: typeof d.reason === 'string' ? d.reason : null,
    sent: Array.isArray(d.actions) && d.actions.some(a => a?.sent === true),
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const automations: DemoHandlers<'automations'> = {
  list: () => ordered().map(toOutput),

  get: input => toOutput(getRule(input.id)),

  create: (input) => {
    const at = new Date()
    const rule: DemoRule = {
      id: nextId++,
      name: input.name,
      enabled: input.enabled ?? true,
      side: input.side ?? null,
      priority: input.priority ?? 0,
      dryRun: input.dryRun ?? true,
      cooldownMin: input.cooldownMin ?? null,
      trigger: input.trigger,
      conditions: input.conditions as Condition,
      actions: input.actions as Action[],
      createdAt: at,
      updatedAt: at,
    }
    rules.set(rule.id, rule)
    return toOutput(rule)
  },

  update: (input) => {
    const { id, ...patch } = input
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<DemoRule>
    return toOutput(update(id, defined))
  },

  setEnabled: input => toOutput(update(input.id, { enabled: input.enabled })),

  setDryRun: input => toOutput(update(input.id, { dryRun: input.dryRun })),

  delete: (input) => {
    getRule(input.id)
    rules.delete(input.id)
    return { success: true }
  },

  getKillSwitch: () => ({ enabled: globalEnabled }),

  setKillSwitch: (input) => {
    if (globalEnabled && !input.enabled) globalOffSince = now()
    if (input.enabled) globalOffSince = null
    globalEnabled = input.enabled
    return { enabled: globalEnabled }
  },

  runs: (input) => {
    const limit = input.limit ?? 100
    const since = now() - DAY
    const pick = input.automationId != null ? [getRule(input.automationId)] : ordered()
    return pick
      .flatMap(r => loggedRuns(r, since).map(run => ({ ...run, ruleName: r.name })))
      .sort((a, b) => b.firedAt.getTime() - a.firedAt.getTime())
      .slice(0, limit)
      .map((r, i) => ({ id: i + 1, automationId: r.automationId, ruleName: r.ruleName, firedAt: r.firedAt, outcome: r.outcome, detail: r.detail }))
  },

  status: () => {
    const midnight = startOfDay().getTime()
    return {
      globalEnabled,
      rules: ordered().map((r) => {
        const runs = loggedRuns(r, now() - 2 * DAY)
        const last = runs[runs.length - 1]
        return {
          id: r.id,
          name: r.name,
          enabled: r.enabled,
          dryRun: r.dryRun,
          side: r.side,
          cooldownMin: r.cooldownMin,
          lastOutcome: last?.outcome ?? null,
          lastFiredAt: last?.firedAt ?? null,
          firesToday: runs.filter(x => x.outcome === 'fired' && x.firedAt.getTime() >= midnight).length,
        }
      }),
    }
  },

  diagnostics: (input) => {
    const at = new Date()
    const midnight = startOfDay()
    const since = new Date(Math.min(midnight.getTime(), at.getTime() - (input.hours ?? 3) * HOUR))
    return {
      now: at,
      since,
      startOfDay: midnight,
      globalEnabled,
      rules: ordered().map(r => ({
        ...toOutput(r),
        runs: loggedRuns(r, since.getTime()).map(x => ({ t: x.firedAt, outcome: x.outcome, ...runSummary(x.detail) })),
        signals: Object.fromEntries(conditionSignals(r.conditions).map(k => [k, liveSignal(k)])),
      })),
    }
  },

  nights: input => recentSessions(input.side, input.limit ?? 7).map((s, i) => ({
    sleepRecordId: sessionId(s),
    ...nightLabel(s, i),
    startMs: s.enteredMs,
    endMs: s.leftMs,
  })),

  backtest: (input) => {
    const night = resolveNight(input.side, input.sleepRecordId)
    if (!night) return { ok: false, message: 'No recorded nights for this side yet — backtest needs sleep history.', night: null, result: null }
    const rule: BacktestRule = {
      side: input.rule.side ?? null,
      cooldownMin: input.rule.cooldownMin ?? null,
      trigger: input.rule.trigger,
      conditions: input.rule.conditions as Condition,
      actions: input.rule.actions as Action[],
    }
    const result = runDemoBacktest(rule, night.session.enteredMs, night.session.leftMs, input.stepMin ?? 2)
    return { ok: true, night: { label: night.label, date: night.date }, result }
  },

  backtestRange: input => backtestNights({
    side: input.rule.side ?? null,
    cooldownMin: input.rule.cooldownMin ?? null,
    trigger: input.rule.trigger,
    conditions: input.rule.conditions as Condition,
    actions: input.rule.actions as Action[],
  }, input.nights ?? 5),

  backtestSummaries: () => ordered().map((r) => {
    const key = `${r.id}:${r.updatedAt.getTime()}:${startOfDay().getTime()}`
    let summary = summaryCache.get(key)
    if (!summary) {
      summary = backtestNights(r, 5)
      summaryCache.set(key, summary)
    }
    return { id: r.id, ...summary }
  }),

  tonight: () => {
    const at = now()
    const control = getDemoDeviceStatus('F').temperatureControl
    const recent = ordered()
      .flatMap(r => loggedRuns(r, at - 12 * HOUR).map(run => ({ run, name: r.name })))
      .filter(x => x.run.outcome === 'fired' || x.run.outcome === 'clamped')
      .sort((a, b) => b.run.firedAt.getTime() - a.run.firedAt.getTime())
    const side = (s: Side) => {
      let lastAutopilot: { ruleName: string, temp: number, at: number } | null = null
      for (const { run, name } of recent) {
        const c = classifyRun({ ...run, outcome: 'fired' }, null)
        if (c.code === 'set-temperature' && c.temp != null && c.sides.includes(s)) {
          lastAutopilot = { ruleName: name, temp: c.temp, at: run.firedAt.getTime() }
          break
        }
      }
      const hold = currentHold(s)
      return {
        control: control?.[s] ?? null,
        hold: hold && { temperature: hold.temperature, startedAt: hold.startedAt, expiresAt: hold.expiresAt },
        runOnceUntil: null,
        lastAutopilot,
      }
    }
    return { now: at, sides: { left: side('left'), right: side('right') } }
  },

  activity: (input) => {
    const at = now()
    const starts = [...input.nightStarts].sort((a, b) => a - b)
    const all = ordered()
    const byId = new Map(all.map(r => [r.id, r]))
    const classified = all.flatMap((r) => {
      const w = conditionTimeWindow(r.conditions)
      return loggedRuns(r, starts[0]).map(run =>
        classifyRun(run, w ? inTimeWindow(localClock(run.firedAt.getTime()).nowMinutes, w) : null))
    })
    const buckets = bucketRuns(classified, starts, at + MINUTE)
    const holds = (['left', 'right'] as const)
      .map(currentHold)
      .filter((h): h is NonNullable<typeof h> => h !== null && h.startedAt >= starts[0])
    return {
      now: at,
      nights: starts.map((start, i) => ({
        start,
        entries: collapseRuns(buckets[i]).map(e => ({ ...e, ruleName: byId.get(e.ruleId)?.name ?? `Rule ${e.ruleId}` })),
      })).reverse(),
      holds,
    }
  },

  capZoneReplay: (input) => {
    const night = resolveNight(input.side, input.sleepRecordId)
    if (!night) return { ok: false, night: null, frames: [] }
    const { enteredMs, leftMs } = night.session
    const count = Math.max(2, Math.min(input.maxFrames ?? 300, Math.floor((leftMs - enteredMs) / MINUTE)))
    const frames = Array.from({ length: count }, (_, i) => {
      const tMs = Math.round(enteredMs + (i * (leftMs - enteredMs)) / (count - 1))
      const zones = capZones(input.side, tMs).map(z => Math.round(z * 100) / 100)
      return { tMs, zones, peakZone: zones.indexOf(Math.max(...zones)) }
    })
    return { ok: true, night: { label: night.label, date: night.date }, frames }
  },
}
