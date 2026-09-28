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

import { MAX_TEMP, MIN_TEMP } from '@/src/hardware/types'
import type { TemperatureController, TemperatureRequest } from '@/src/temperature/controller'
import { DEFAULT_HOLD_MS } from '@/src/temperature/controller'
import { evaluateCondition } from './evaluator'
import type { EvalContext } from './expressions'
import { evaluateExpr } from './expressions'
import { collectWindowSignals, type SignalReader } from './signals'
import {
  AUTOMATION_DEFAULT_USER_MAX,
  AUTOMATION_DEFAULT_USER_MIN,
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

/** How many minutes after a timeOfDay slot a late tick may still fire it. */
const TIME_OF_DAY_GRACE_MIN = 10

export interface AutomationEngineDeps {
  signals: SignalReader
  /** Epoch ms — injectable for deterministic tests. */
  now: () => number
  /** Timezone-aware wall clock. dateKey (local yyyy-mm-dd) keys timeOfDay
   * "already fired today"; when absent, dayOfWeek is used as a fallback. */
  clock: () => { nowMinutes: number, dayOfWeek: DayOfWeek, dateKey?: string }
  control: Pick<TemperatureController, 'replaceAutopilot' | 'automationBaseline' | 'powerOff'>
  loadRules: () => Promise<AutomationRule[]>
  recordRun: (automationId: number, outcome: RunOutcome, detail: unknown) => Promise<void>
  /** Persist enabled=false when the runaway guard trips. */
  disableRule: (automationId: number) => Promise<void>
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
  private triggerFingerprints = new Map<number, string>()
  private windows = new WindowStore()
  private actionWindows = new WindowStore()
  private windowSignals = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false

  // Global kill-switch. When false, ticks short-circuit and no rule is
  // evaluated or commanded — per-rule enabled/dryRun state is left untouched, so
  // re-enabling resumes every rule exactly as it was. Persisted in
  // deviceSettings.autopilotEnabled; the instance restores it at boot.
  private globalEnabled = true

  private publishErrors: Partial<Record<Side, unknown>> = {}
  private generation = 0
  private leases: Record<Side, Map<string, TemperatureRequest & { policy: boolean }>> = {
    left: new Map(), right: new Map(),
  }

  private pendingRuns: Array<{ rule: AutomationRule, results: ActionResult[] }> = []
  private pendingOff = new Set<Side>()
  private pendingOn: Record<Side, string[]> = { left: [], right: [] }

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
    const hadLeases = this.leases.left.size + this.leases.right.size > 0
    const nextRules = await this.deps.loadRules()
    const nextIds = new Set<number>()
    for (const rule of nextRules) {
      nextIds.add(rule.id)
      const nextTrigger = JSON.stringify(rule.trigger)
      if (this.triggerFingerprints.get(rule.id) !== nextTrigger) {
        this.runtime.delete(rule.id)
      }
      this.triggerFingerprints.set(rule.id, nextTrigger)
    }

    this.generation++
    const unchanged = new Set(nextRules.filter(next => next.enabled && !next.dryRun
      && this.rules.some(old => old.id === next.id && JSON.stringify(old) === JSON.stringify(next))).map(r => r.id))
    for (const side of ['left', 'right'] as const) {
      for (const id of this.leases[side].keys()) {
        if (!unchanged.has(Number(id.split(':')[1]))) this.leases[side].delete(id)
      }
    }
    this.rules = nextRules
    this.windowSignals = collectWindowSignals(this.rules)
    // Drop runtime for rules that no longer exist.
    for (const id of [...this.runtime.keys()]) {
      if (!nextIds.has(id)) this.runtime.delete(id)
    }
    for (const id of [...this.triggerFingerprints.keys()]) {
      if (!nextIds.has(id)) this.triggerFingerprints.delete(id)
    }
    if (hadLeases) await this.publishLeases(this.generation)
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.setGlobalEnabled(false)
  }

  /** Flip the persisted kill-switch and immediately revoke every outstanding lease. */
  async setGlobalEnabled(on: boolean): Promise<void> {
    this.globalEnabled = on
    this.generation++
    if (!on) {
      this.leases = { left: new Map(), right: new Map() }
      await this.publishLeases(this.generation)
    }
    this.deps.log?.(`AutomationEngine global kill-switch ${on ? 'ON (running)' : 'OFF (halted)'}`)
  }

  private async publishLeases(generation: number, allowPowerOn = false) {
    const statuses = {} as Record<Side, Awaited<ReturnType<TemperatureController['replaceAutopilot']>>>
    this.publishErrors = {}
    for (const side of ['left', 'right'] as const) {
      try {
        statuses[side] = await this.deps.control.replaceAutopilot(
          side, [...this.leases[side].values()], allowPowerOn ? this.pendingOn[side] : [],
          () => generation === this.generation,
        )
      }
      catch (error) {
        this.publishErrors[side] = error
        statuses[side] = { source: null, requestId: null, targetTemperature: null, holdUntil: null, blocked: null }
        this.deps.log?.(`Temperature controller failed on ${side}: ${String(error)}`)
      }
    }
    return statuses
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
      const generation = this.generation
      this.pendingRuns = []
      this.pendingOff.clear()
      this.pendingOn = { left: [], right: [] }
      const now = this.deps.now()
      for (const side of ['left', 'right'] as const) {
        for (const [id, lease] of this.leases[side]) {
          if (lease.expiresAt <= now) this.leases[side].delete(id)
        }
      }
      const snapshot = this.deps.signals.read()
      const { nowMinutes, dayOfWeek, dateKey } = this.deps.clock()

      // Feed windowed-aggregate buffers, then prune to the largest window asked.
      for (const key of this.windowSignals) {
        const v = snapshot[key]
        if (typeof v === 'number') this.windows.record(key, v, now)
        const target = /^(left|right)\.(targetTemperature|currentTemperature)$/.exec(key)
        const actionValue = target ? this.deps.control.automationBaseline(target[1] as Side) : v
        if (typeof actionValue === 'number') this.actionWindows.record(key, actionValue, now)
      }
      this.windows.prune(now, this.maxWindowMinutes())
      this.actionWindows.prune(now, this.maxWindowMinutes())

      const ctx: EvalContext = {
        signal: key => snapshot[key],
        windows: this.windows,
        nowMs: now,
        nowMinutes,
        dayOfWeek,
        dateKey,
      }

      for (const rule of this.rules) {
        if (generation !== this.generation) return
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
      if (generation !== this.generation) return
      for (const side of this.pendingOff) {
        try {
          await this.deps.control.powerOff(side, () => generation === this.generation)
        }
        catch (error) {
          for (const { results } of this.pendingRuns) {
            for (const result of results) {
              if (result.side === side && result.on === false) result.error = String(error)
            }
          }
        }
        this.pendingOn[side] = [] // shutdown wins over temperature actions this tick
      }
      const statuses = await this.publishLeases(generation, true)
      if (generation !== this.generation) return
      for (const { rule, results } of this.pendingRuns) {
        for (const result of results) {
          if (result.kind === 'setPower' && result.on === false && result.sent && !result.error && !result.dryRun) {
            // Coalesced shutdowns count for each rule that requested a successful
            // side cutoff. Failed/dry-run commands consume no runaway budget.
            this.getRuntime(rule.id).actionTimes.push(now)
          }
          if (!result.requestId || !result.side || result.dryRun) continue
          if (this.publishErrors[result.side] !== undefined) {
            result.error = String(this.publishErrors[result.side])
            continue
          }
          const status = statuses[result.side]
          if (!status.blocked && status.requestId === result.requestId) {
            result.sent = !result.antiThrash
            if (result.sent) this.getRuntime(rule.id).actionTimes.push(now)
          }
          else {
            result.antiThrash = false
            result.skipped = status.blocked ?? (status.source === 'manual' ? 'manual-hold' : status.source ?? 'superseded')
          }
        }
        await this.deps.recordRun(rule.id, aggregateOutcome(rule.dryRun, results), { actions: results })
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
        if (t.days && !t.days.includes(ctx.dayOfWeek)) return false
        // Fire on the first tick at-or-after the slot, within a grace window:
        // exact-minute equality silently skipped the slot whenever a tick
        // landed >60s late (engine stall, scheduler reload). The window stays
        // bounded so an engine (re)started hours later doesn't fire a long-
        // gone morning slot at 3pm.
        if (ctx.nowMinutes < atMin || ctx.nowMinutes > atMin + TIME_OF_DAY_GRACE_MIN) {
          return false
        }
        // Key by local calendar date so the same slot re-arms next week
        // (weekday-only keys blocked every later occurrence for the life of
        // the process) but fires at most once per day.
        const key = `${ctx.dateKey ?? ctx.dayOfWeek}:${atMin}`
        if (rt.lastTimeKey === key) return false // already fired today
        rt.lastTimeKey = key
        return true
      }
    }
  }

  private async evaluateRule(rule: AutomationRule, ctx: EvalContext, now: number): Promise<void> {
    const generation = this.generation
    const rt = this.getRuntime(rule.id)
    const firstSignalSample = !rt.lastTriggerSeen
    const triggered = this.triggerActive(rule, ctx, now, rt)
    // A live signal policy can reacquire ownership after edits, enable/disable,
    // condition recovery, or lease expiry without inventing a signal edge.
    // Synthetic activation must never replay a sibling notify/one-shot action.
    const unownedPolicies = new Set<number>()
    if (rule.trigger.kind === 'signalChange' && ctx.signal(rule.trigger.signal) !== undefined
      && (!rule.dryRun || firstSignalSample)) {
      rule.actions.forEach((action, index) => {
        if (!isPolicyAction(rule, action)) return
        const sides: Side[] = action.kind !== 'notify' && action.side ? [action.side] : rule.side ? [rule.side] : ['left', 'right']
        if (sides.some(side => !this.leases[side].has(`rule:${rule.id}:${index}`))) unownedPolicies.add(index)
      })
    }

    // IF — three-valued. unknown/false both skip (never fire on missing data).
    const cond = evaluateCondition(rule.conditions, ctx)
    if (cond !== true) {
      this.removeLeases(rule.id, true)
      if (!triggered) return
      await this.deps.recordRun(rule.id, 'skipped', {
        reason: cond === undefined ? 'condition-unknown' : 'condition-false',
      })
      return
    }

    // Policies remain valid between triggers, but a stopped engine cannot keep
    // owning a side forever. Conditions are checked on every evaluator tick.
    for (const side of ['left', 'right'] as const) {
      for (const [id, lease] of this.leases[side]) {
        if (id.startsWith(`rule:${rule.id}:`) && lease.policy) lease.expiresAt = now + 2 * AUTOMATION_TICK_MS
      }
    }
    if (!triggered && !unownedPolicies.size) return

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
      if (generation !== this.generation) return
      rule.enabled = false
      this.removeLeases(rule.id)
      await this.deps.recordRun(rule.id, 'error', {
        reason: 'runaway-disabled',
        actionsLastHour: rt.actionTimes.length,
      })
      this.deps.log?.(`AutomationEngine disabled rule ${rule.id} (${rule.name}): runaway guard`)
      return
    }

    // THEN — run actions, tracking the aggregate outcome.
    const results: ActionResult[] = []
    for (const [index, action] of rule.actions.entries()) {
      if (!triggered && !unownedPolicies.has(index)) continue
      if (generation !== this.generation) return
      results.push(...(await this.runAction(rule, action, index, ctx, now)))
    }

    if (results.some(r => r.requestId || r.notified || r.sent || r.dryRun)) rt.lastFiredMs = now
    this.pendingRuns.push({ rule, results })
  }

  private removeLeases(ruleId: number, policiesOnly = false): void {
    for (const side of ['left', 'right'] as const) {
      for (const [id, lease] of this.leases[side]) {
        if (id.startsWith(`rule:${ruleId}:`) && (!policiesOnly || lease.policy)) this.leases[side].delete(id)
      }
    }
  }

  private async runAction(
    rule: AutomationRule,
    action: Action,
    index: number,
    ctx: EvalContext,
    now: number,
  ): Promise<ActionResult[]> {
    if (action.kind === 'notify') {
      this.deps.notify(rule.id, action.message)
      return [{ kind: 'notify', notified: true }]
    }
    const sides: Side[] = action.side ? [action.side] : (rule.side ? [rule.side] : ['left', 'right'])
    const results: ActionResult[] = []
    for (const side of sides) {
      const id = `rule:${rule.id}:${index}`
      if (action.kind === 'setPower' && !action.on) {
        if (!rule.dryRun) this.pendingOff.add(side)
        results.push({ kind: action.kind, side, on: false, sent: !rule.dryRun, dryRun: rule.dryRun })
        continue
      }
      const expr = action.temp
      const policy = isPolicyAction(rule, action)
      const previous = this.leases[side].get(id)
      // One-shot targets are resolved once, including while masked by a manual
      // hold. Reconciliation and repeated trigger ticks cannot compound them.
      if (!policy && previous && previous.expiresAt > now) {
        results.push({ kind: action.kind, side, requestId: id, temp: previous.temperature, antiThrash: true })
        continue
      }
      const actionContext: EvalContext = {
        ...ctx,
        windows: this.actionWindows,
        signal: (key) => {
          const target = /^(left|right)\.(targetTemperature|currentTemperature)$/.exec(key)
          return target ? this.deps.control.automationBaseline(target[1] as Side) : ctx.signal(key)
        },
      }
      const raw = expr ? evaluateExpr(expr, actionContext) : 75
      if (raw === undefined) {
        this.leases[side].delete(id)
        results.push({ kind: action.kind, side, skipped: 'temp-unknown' })
        continue
      }
      const userMin = action.kind === 'setTemperature' ? action.clamp?.min ?? AUTOMATION_DEFAULT_USER_MIN : AUTOMATION_DEFAULT_USER_MIN
      const userMax = action.kind === 'setTemperature' ? action.clamp?.max ?? AUTOMATION_DEFAULT_USER_MAX : AUTOMATION_DEFAULT_USER_MAX
      const temp = Math.min(MAX_TEMP, Math.max(MIN_TEMP, Math.min(userMax, Math.max(userMin, raw))))
      const clamped = temp !== raw
      if (rule.dryRun) {
        results.push({ kind: action.kind, side, dryRun: true, raw, temp, clamped })
        continue
      }
      const effectiveTemp = previous && Math.abs(previous.temperature - temp) < 0.5 ? previous.temperature : temp
      const lease = {
        id, source: 'autopilot' as const, temperature: effectiveTemp, priority: rule.priority,
        startsAt: previous?.startsAt ?? now, createdAt: previous?.createdAt ?? now,
        expiresAt: now + (policy ? 2 * AUTOMATION_TICK_MS : (action.holdMinutes ?? DEFAULT_HOLD_MS / 60_000) * 60_000),
        durationSec: action.kind === 'setTemperature' ? action.durationSec : undefined,
        policy,
      }
      this.leases[side].set(id, lease)
      if (action.kind === 'setPower' && action.on && !previous) this.pendingOn[side].push(id)
      results.push({
        kind: action.kind, side, requestId: id, raw, temp, clamped,
        antiThrash: previous !== undefined && Math.abs(previous.temperature - temp) < 0.5,
      })
    }
    return results
  }
}

interface ActionResult {
  requestId?: string
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

/** Feedback-based actions are one-shot unless explicitly configured as policies. */
function referencesTarget(expr: Expr): boolean {
  switch (expr.kind) {
    case 'window':
    case 'signal': return /\.(targetTemperature|currentTemperature)$/.test(expr.signal)
    case 'binary': return referencesTarget(expr.left) || referencesTarget(expr.right)
    case 'clamp': return referencesTarget(expr.value) || referencesTarget(expr.min) || referencesTarget(expr.max)
    default: return false
  }
}

function isPolicyAction(rule: AutomationRule, action: Action): boolean {
  if (action.kind === 'notify' || (action.kind === 'setPower' && !action.on)) return false
  return action.mode
    ? action.mode === 'policy'
    : rule.trigger.kind !== 'timeOfDay' && (!action.temp || !referencesTarget(action.temp))
}
