/**
 * AutomationEngine — the reactive rules engine that sits beside the scheduler's
 * JobManager. It evaluates user-built WHEN/IF/THEN automations on a periodic
 * tick and writes through the SAME hardware path the scheduler uses
 * (getSharedHardwareClient + per-side mutex + broadcastMutationStatus +
 * markSideMutated). It introduces no new hardware path.
 *
 * Safety properties (see docs/adr/0023-autopilot-reactive-automations.md "Safety stack"):
 *   - Two-layer temp clamp: per-action user band, then hardware 55–110°F.
 *   - Anti-thrash: a setpoint is only re-sent to hardware when it moves ≥0.5°F.
 *   - Runaway guard: a rule exceeding N hardware actions/hour auto-disables.
 *   - Manual-override hold: touching the dial suspends autopilot on that side.
 *   - Run-once gate: never writes a side with an active run-once session.
 *   - Dry-run: notify-only; logs would-fire events without touching hardware.
 *
 * Every evaluation (i.e. every tick where a rule's trigger is active) writes one
 * row to automation_runs with outcome fired/skipped/clamped/dry_run/error — the
 * audit log that powers the transparency wedge.
 *
 * The engine is fully dependency-injected so it unit-tests without hardware,
 * the DB, or timers. `src/automation/instance.ts` wires the production deps.
 */

import { MAX_TEMP, MIN_TEMP, fahrenheitToLevel } from '@/src/hardware/types'
import { evaluateCondition } from './evaluator'
import type { EvalContext } from './expressions'
import { evaluateExpr } from './expressions'
import { collectWindowSignals, type SignalReader } from './signals'
import {
  AUTOMATION_ANTI_THRASH_F,
  AUTOMATION_DEFAULT_USER_MAX,
  AUTOMATION_DEFAULT_USER_MIN,
  AUTOMATION_MANUAL_OVERRIDE_MS,
  AUTOMATION_MAX_ACTIONS_PER_HOUR,
  AUTOMATION_TICK_MS,
  type Action,
  type AutomationRule,
  type DayOfWeek,
  type Expr,
  type RunOutcome,
  type Side,
} from './types'
import { WindowStore } from './windows'

/** Minimal hardware surface the engine writes through (shared client shape). */
export interface HardwareWriter {
  connect: () => Promise<void>
  setTemperature: (side: Side, temperature: number, duration?: number) => Promise<void>
  setPower: (side: Side, powered: boolean, temperature?: number) => Promise<void>
}

export interface AutomationEngineDeps {
  signals: SignalReader
  /** Epoch ms — injectable for deterministic tests. */
  now: () => number
  /** Timezone-aware wall clock. */
  clock: () => { nowMinutes: number, dayOfWeek: DayOfWeek }
  getHardware: () => HardwareWriter
  withSideLock: <T>(side: Side, fn: () => Promise<T>) => Promise<T>
  broadcast: (side: Side, overlay: Record<string, unknown>) => void
  markMutated: (side: Side) => void
  loadRules: () => Promise<AutomationRule[]>
  recordRun: (automationId: number, outcome: RunOutcome, detail: unknown) => Promise<void>
  /** Persist enabled=false when the runaway guard trips. */
  disableRule: (automationId: number) => Promise<void>
  hasActiveRunOnceSession: (side: Side) => Promise<boolean>
  /** Side-effect for notify actions (e.g. push/log); never touches hardware. */
  notify: (automationId: number, message: string) => void
  log?: (msg: string) => void
}

interface RuleRuntime {
  lastFiredMs: number | null
  /** Timestamps of real hardware actions in the trailing hour (runaway guard). */
  actionTimes: number[]
  /** Last observed value of a signalChange trigger's signal. */
  lastTriggerValue?: number
  lastTriggerSeen: boolean
  /** Last tick a `tick` trigger evaluated. */
  lastTickEvalMs: number
  /** Day+minute key the last time a `timeOfDay` trigger fired (dedupe). */
  lastTimeKey?: string
}

export class AutomationEngine {
  private deps: AutomationEngineDeps
  private rules: AutomationRule[] = []
  private runtime = new Map<number, RuleRuntime>()
  private windows = new WindowStore()
  private windowSignals = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  // Global kill-switch. When false, ticks short-circuit and no rule is
  // evaluated or commanded — per-rule enabled/dryRun state is left untouched, so
  // re-enabling resumes every rule exactly as it was. Persisted in
  // deviceSettings.autopilotEnabled; the instance restores it at boot.
  private globalEnabled = true

  // Per-side runtime state shared across rules.
  private lastAsserted: Record<Side, number | undefined> = { left: undefined, right: undefined }
  private manualOverrideUntil: Record<Side, number> = { left: 0, right: 0 }

  constructor(deps: AutomationEngineDeps) {
    this.deps = deps
  }

  /** Load rules and start the periodic tick. */
  async start(): Promise<void> {
    await this.reload()
    if (!this.timer) {
      this.timer = setInterval(() => {
        void this.tick()
      }, AUTOMATION_TICK_MS)
      // Don't keep the process alive solely for the engine tick.
      if (typeof this.timer.unref === 'function') this.timer.unref()
    }
    this.deps.log?.(`AutomationEngine started with ${this.rules.length} automations`)
  }

  /** Reload automations from the source (call after CRUD mutations). */
  async reload(): Promise<void> {
    this.rules = await this.deps.loadRules()
    this.windowSignals = collectWindowSignals(this.rules)
    // Drop runtime for rules that no longer exist.
    const ids = new Set(this.rules.map(r => r.id))
    for (const id of [...this.runtime.keys()]) {
      if (!ids.has(id)) this.runtime.delete(id)
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Suspend autopilot on a side for the manual-override hold window. A router or
   * gesture handler calls this when the user changes the dial directly.
   */
  registerManualOverride(side: Side): void {
    this.manualOverrideUntil[side] = this.deps.now() + AUTOMATION_MANUAL_OVERRIDE_MS
  }

  /** Flip the global kill-switch. `false` suspends all evaluation immediately. */
  setGlobalEnabled(on: boolean): void {
    this.globalEnabled = on
    this.deps.log?.(`AutomationEngine global kill-switch ${on ? 'ON (running)' : 'OFF (halted)'}`)
  }

  /** Whether autopilot is globally enabled (kill-switch not engaged). */
  isGloballyEnabled(): boolean {
    return this.globalEnabled
  }

  private getRuntime(id: number): RuleRuntime {
    let rt = this.runtime.get(id)
    if (!rt) {
      rt = { lastFiredMs: null, actionTimes: [], lastTriggerSeen: false, lastTickEvalMs: 0 }
      this.runtime.set(id, rt)
    }
    return rt
  }

  /** One evaluation pass over all enabled rules. */
  async tick(): Promise<void> {
    if (!this.globalEnabled) return // kill-switch engaged — evaluate nothing
    if (this.ticking) return // never overlap ticks
    this.ticking = true
    try {
      const now = this.deps.now()
      const snapshot = this.deps.signals.read()
      const { nowMinutes, dayOfWeek } = this.deps.clock()

      // Feed windowed-aggregate buffers, then prune to the largest window asked.
      for (const key of this.windowSignals) {
        const v = snapshot[key]
        if (typeof v === 'number') this.windows.record(key, v, now)
      }
      this.windows.prune(now, this.maxWindowMinutes())

      const ctx: EvalContext = {
        signal: key => snapshot[key],
        windows: this.windows,
        nowMs: now,
        nowMinutes,
        dayOfWeek,
      }

      for (const rule of this.rules) {
        if (!rule.enabled) continue
        try {
          await this.evaluateRule(rule, ctx, now)
        }
        catch (err) {
          await this.deps.recordRun(rule.id, 'error', {
            reason: 'eval-threw',
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    finally {
      this.ticking = false
    }
  }

  private maxWindowMinutes(): number {
    let max = 10
    for (const rule of this.rules) {
      if (!rule.enabled) continue
      max = Math.max(max, windowMinsInCondition(rule.conditions))
      for (const a of rule.actions) {
        if (a.kind === 'setTemperature') max = Math.max(max, windowMinsInExpr(a.temp))
        if (a.kind === 'setPower' && a.temp) max = Math.max(max, windowMinsInExpr(a.temp))
      }
    }
    return max
  }

  /** Is this rule's trigger active on this tick? Mutates trigger runtime. */
  private triggerActive(rule: AutomationRule, ctx: EvalContext, now: number, rt: RuleRuntime): boolean {
    const t = rule.trigger
    switch (t.kind) {
      case 'tick': {
        const due = now - rt.lastTickEvalMs >= t.everyMin * 60_000
        if (due) rt.lastTickEvalMs = now
        return due
      }
      case 'signalChange': {
        const v = ctx.signal(t.signal)
        if (v === undefined) return false
        const changed = rt.lastTriggerSeen && v !== rt.lastTriggerValue
        rt.lastTriggerValue = v
        rt.lastTriggerSeen = true
        return changed
      }
      case 'timeOfDay': {
        const [h, m] = t.at.split(':').map(Number)
        const atMin = h * 60 + m
        if (ctx.nowMinutes !== atMin) return false
        if (t.days && !t.days.includes(ctx.dayOfWeek)) return false
        const key = `${ctx.dayOfWeek}:${atMin}`
        if (rt.lastTimeKey === key) return false // already fired this minute
        rt.lastTimeKey = key
        return true
      }
    }
  }

  private async evaluateRule(rule: AutomationRule, ctx: EvalContext, now: number): Promise<void> {
    const rt = this.getRuntime(rule.id)
    if (!this.triggerActive(rule, ctx, now, rt)) return // not an eval; no audit row

    // IF — three-valued. unknown/false both skip (never fire on missing data).
    const cond = evaluateCondition(rule.conditions, ctx)
    if (cond !== true) {
      await this.deps.recordRun(rule.id, 'skipped', {
        reason: cond === undefined ? 'condition-unknown' : 'condition-false',
      })
      return
    }

    // Cooldown gate.
    if (rule.cooldownMin != null && rt.lastFiredMs != null
      && now - rt.lastFiredMs < rule.cooldownMin * 60_000) {
      await this.deps.recordRun(rule.id, 'skipped', { reason: 'cooldown' })
      return
    }

    // Runaway guard — prune the trailing hour and trip if over budget.
    rt.actionTimes = rt.actionTimes.filter(ts => now - ts < 3_600_000)
    if (rt.actionTimes.length >= AUTOMATION_MAX_ACTIONS_PER_HOUR) {
      await this.deps.disableRule(rule.id)
      rule.enabled = false
      await this.deps.recordRun(rule.id, 'error', {
        reason: 'runaway-disabled',
        actionsLastHour: rt.actionTimes.length,
      })
      this.deps.log?.(`AutomationEngine disabled rule ${rule.id} (${rule.name}): runaway guard`)
      return
    }

    // THEN — run actions, tracking the aggregate outcome.
    const results: ActionResult[] = []
    for (const action of rule.actions) {
      results.push(...(await this.runAction(rule, action, ctx, now, rt)))
    }

    const outcome = aggregateOutcome(rule.dryRun, results)
    if (outcome === 'fired' || outcome === 'clamped' || outcome === 'dry_run') {
      rt.lastFiredMs = now
    }
    await this.deps.recordRun(rule.id, outcome, { actions: results })
  }

  private async runAction(
    rule: AutomationRule,
    action: Action,
    ctx: EvalContext,
    now: number,
    rt: RuleRuntime,
  ): Promise<ActionResult[]> {
    if (action.kind === 'notify') {
      this.deps.notify(rule.id, action.message)
      return [{ kind: 'notify', notified: true }]
    }

    // A null rule side (the builder's "both") fans a hardware action out to both
    // sides. The temp expression's signal keys are already side-resolved at build
    // time — a "both" rule reads the left side (builderModel.toAST) — so the
    // resolved setpoint is shared; only the write target differs per side.
    const sides: Side[] = action.side ? [action.side] : (rule.side ? [rule.side] : ['left', 'right'])

    // Resolve the target temperature (setPower may have none → hardware default).
    let raw: number | undefined
    if (action.kind === 'setTemperature') raw = evaluateExpr(action.temp, ctx)
    else if (action.temp) raw = evaluateExpr(action.temp, ctx)

    if (action.kind === 'setTemperature' && raw === undefined) {
      return sides.map(side => ({ kind: action.kind, side, skipped: 'temp-unknown' }))
    }

    // Two-layer clamp (only when a temperature is involved).
    let temp: number | undefined
    let clamped = false
    if (raw !== undefined) {
      const userMin = action.kind === 'setTemperature' ? action.clamp?.min ?? AUTOMATION_DEFAULT_USER_MIN : AUTOMATION_DEFAULT_USER_MIN
      const userMax = action.kind === 'setTemperature' ? action.clamp?.max ?? AUTOMATION_DEFAULT_USER_MAX : AUTOMATION_DEFAULT_USER_MAX
      const layer1 = Math.min(Math.max(raw, userMin), userMax)
      const layer2 = Math.min(Math.max(layer1, MIN_TEMP), MAX_TEMP)
      temp = layer2
      clamped = layer2 !== raw
    }

    const out: ActionResult[] = []
    for (const side of sides) {
      out.push(await this.writeSide(rule, action, side, now, rt, raw, temp, clamped))
    }
    return out
  }

  /** Apply one resolved hardware action to a single side (gates + write). */
  private async writeSide(
    rule: AutomationRule,
    action: Exclude<Action, { kind: 'notify' }>,
    side: Side,
    now: number,
    rt: RuleRuntime,
    raw: number | undefined,
    temp: number | undefined,
    clamped: boolean,
  ): Promise<ActionResult> {
    // Side gates apply only to real hardware writes.
    if (this.manualOverrideUntil[side] > now) {
      return { kind: action.kind, side, skipped: 'manual-override', raw, temp, clamped }
    }
    if (await this.deps.hasActiveRunOnceSession(side)) {
      return { kind: action.kind, side, skipped: 'run-once', raw, temp, clamped }
    }

    // Anti-thrash: skip a sub-threshold re-assertion of the same setpoint.
    if (action.kind === 'setTemperature' && temp !== undefined) {
      const last = this.lastAsserted[side]
      if (last !== undefined && Math.abs(temp - last) < AUTOMATION_ANTI_THRASH_F) {
        return { kind: action.kind, side, antiThrash: true, raw, temp, clamped }
      }
    }

    // Dry-run: log the would-be command but never touch hardware.
    if (rule.dryRun) {
      return { kind: action.kind, side, dryRun: true, raw, temp, clamped, on: action.kind === 'setPower' ? action.on : undefined }
    }

    // Real write through the shared, serialized hardware path.
    await this.deps.withSideLock(side, async () => {
      const hw = this.deps.getHardware()
      await hw.connect()
      if (action.kind === 'setTemperature') {
        if (temp === undefined) return // unreachable: setTemperature always resolves a temp
        await hw.setTemperature(side, temp, action.durationSec)
        this.deps.markMutated(side)
        this.deps.broadcast(side, { targetTemperature: temp, targetLevel: fahrenheitToLevel(temp) })
        this.lastAsserted[side] = temp
      }
      else {
        await hw.setPower(side, action.on, temp)
        this.deps.markMutated(side)
        this.deps.broadcast(side, action.on
          ? { targetTemperature: temp ?? 75, targetLevel: fahrenheitToLevel(temp ?? 75) }
          : { targetLevel: 0 })
        if (action.on && temp !== undefined) this.lastAsserted[side] = temp
        else if (!action.on) this.lastAsserted[side] = undefined
      }
    })
    rt.actionTimes.push(now)
    return { kind: action.kind, side, sent: true, raw, temp, clamped, on: action.kind === 'setPower' ? action.on : undefined }
  }
}

interface ActionResult {
  kind: Action['kind']
  side?: Side
  notified?: boolean
  sent?: boolean
  dryRun?: boolean
  antiThrash?: boolean
  clamped?: boolean
  skipped?: string
  error?: string
  raw?: number
  temp?: number
  on?: boolean
}

/** Largest window (minutes) referenced anywhere in an expression tree. */
function windowMinsInExpr(expr: Expr): number {
  switch (expr.kind) {
    case 'window':
      return expr.lastMin
    case 'binary':
      return Math.max(windowMinsInExpr(expr.left), windowMinsInExpr(expr.right))
    case 'clamp':
      return Math.max(windowMinsInExpr(expr.value), windowMinsInExpr(expr.min), windowMinsInExpr(expr.max))
    default:
      return 0
  }
}

/** Largest window (minutes) referenced anywhere in a condition tree. */
function windowMinsInCondition(cond: AutomationRule['conditions']): number {
  switch (cond.kind) {
    case 'and':
    case 'or':
      return cond.conditions.reduce((m, c) => Math.max(m, windowMinsInCondition(c)), 0)
    case 'not':
      return windowMinsInCondition(cond.condition)
    case 'compare':
      return Math.max(windowMinsInExpr(cond.left), windowMinsInExpr(cond.right))
    case 'between':
      return Math.max(
        windowMinsInExpr(cond.subject),
        windowMinsInExpr(cond.min),
        windowMinsInExpr(cond.max),
      )
    default:
      return 0
  }
}

/** Fold per-action results into the single run outcome (worst-meaningful). */
function aggregateOutcome(dryRun: boolean, results: ActionResult[]): RunOutcome {
  if (results.some(r => r.error)) return 'error'
  const acted = results.filter(r => r.notified || r.sent || r.dryRun || r.antiThrash)
  if (acted.length === 0) return 'skipped' // every action gated out
  if (dryRun && results.some(r => r.dryRun)) return 'dry_run'
  if (results.some(r => r.clamped && (r.sent || r.antiThrash))) return 'clamped'
  return 'fired'
}
