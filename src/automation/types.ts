/**
 * Automations rules-engine model — the WHEN / IF / THEN "language".
 *
 * These are hand-authored AST types and serve as the single source of truth:
 * the zod schemas in `src/server/validation-schemas.ts` validate JSON against
 * these shapes at the boundary, and the engine evaluates them directly.
 */

export type Side = 'left' | 'right'

export type DayOfWeek
  = | 'sunday'
    | 'monday'
    | 'tuesday'
    | 'wednesday'
    | 'thursday'
    | 'friday'
    | 'saturday'

export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!='
export type BinaryOp = '+' | '-' | '*' | '/'
export type WindowFn = 'avg' | 'min' | 'max' | 'sum' | 'count'

/**
 * Expression AST — used for both condition operands and action params.
 * Every node evaluates to a number, or `undefined` when a referenced signal is
 * unavailable (which propagates so a rule skips rather than firing on missing
 * data).
 */
export type Expr
  = | { kind: 'literal', value: number }
    | { kind: 'signal', signal: string }
    | { kind: 'window', fn: WindowFn, signal: string, lastMin: number }
    | { kind: 'binary', op: BinaryOp, left: Expr, right: Expr }
    | { kind: 'clamp', value: Expr, min: Expr, max: Expr }

/**
 * Condition AST — an AND/OR/NOT tree over comparisons. Evaluates to a boolean,
 * or `undefined` ("unknown") when an underlying signal is unavailable.
 *
 * `hysteresis` and `sustained` are the stability primitives that keep a rule
 * from chattering at a threshold. They are stateful across ticks — the engine
 * and backtest thread a per-rule `condState` keyed by each node's position in
 * the tree (see EvalContext). In a stateless one-shot evaluation they degrade
 * to an instantaneous reading.
 */
export type Condition
  = | { kind: 'and', conditions: Condition[] }
    | { kind: 'or', conditions: Condition[] }
    | { kind: 'not', condition: Condition }
    | { kind: 'compare', op: CompareOp, left: Expr, right: Expr }
    | { kind: 'between', subject: Expr, min: Expr, max: Expr }
    | { kind: 'timeBetween', start: string, end: string } // HH:MM, wraps past midnight
    | { kind: 'onDays', days: DayOfWeek[] }
    // Latching comparison with separate on/off thresholds. Direction is implied
    // by their order: `on >= off` latches true when `subject` rises to `on` and
    // false when it falls to `off`; `on < off` latches true when `subject` drops
    // to `on` and false when it rises to `off`. The gap between the two is the
    // dead-band that stops boundary chatter.
    | { kind: 'hysteresis', subject: Expr, on: number, off: number }
    // Debounce: `condition` must hold true continuously for `forMin` minutes
    // before this evaluates true. Any false/unknown tick resets the streak.
    | { kind: 'sustained', condition: Condition, forMin: number }

/**
 * Trigger (WHEN) — what wakes the rule up for an evaluation.
 */
export type Trigger
  = | { kind: 'tick', everyMin: number }
    | { kind: 'signalChange', signal: string }
    | { kind: 'timeOfDay', at: string, days?: DayOfWeek[] } // HH:MM

/**
 * Action (THEN). `notify` is the no-hardware safe default. `setTemperature`
 * carries an optional per-action clamp band (layer 1 of the two-layer clamp);
 * `side` defaults to the rule's side.
 */
export type Action
  = | { kind: 'notify', message: string }
    | {
      kind: 'setTemperature'
      side?: Side
      temp: Expr
      clamp?: { min: number, max: number }
      durationSec?: number
    }
    | { kind: 'setPower', side?: Side, on: boolean, temp?: Expr }

/**
 * A fully-resolved automation as the engine consumes it (JSON columns parsed).
 */
export interface AutomationRule {
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
}

export type RunOutcome = 'fired' | 'skipped' | 'clamped' | 'dry_run' | 'error'

// ---------------------------------------------------------------------------
// Engine tunables (see docs/adr/0023-autopilot-reactive-automations.md "Resolved tunables")
// ---------------------------------------------------------------------------

/** Global evaluator tick — 60s aligns to ambient/movement cadence. */
export const AUTOMATION_TICK_MS = 60_000

/** Manual-override hold: touching the dial suspends automations on that side. */
export const AUTOMATION_MANUAL_OVERRIDE_MS = 30 * 60_000

/** Layer-1 clamp defaults when an action omits its own `clamp` band. */
export const AUTOMATION_DEFAULT_USER_MIN = 60
export const AUTOMATION_DEFAULT_USER_MAX = 100

/** Anti-thrash: only re-assert a setpoint when it moves at least this much. */
export const AUTOMATION_ANTI_THRASH_F = 0.5

/** Runaway guard: a rule firing more than this many times in a rolling hour
 *  is auto-disabled (enabled=false) and surfaced via an `error` run row. */
export const AUTOMATION_MAX_ACTIONS_PER_HOUR = 12
