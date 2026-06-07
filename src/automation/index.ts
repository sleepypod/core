/**
 * Autopilot rules engine — a reactive WHEN/IF/THEN evaluator that sits beside
 * the scheduler's JobManager and writes through the same shared hardware path.
 *
 * See docs/autopilot-plan.md for the model, signal catalog, and safety design.
 */

export { AutomationEngine } from './engine'
export type { AutomationEngineDeps, HardwareWriter } from './engine'
export {
  getAutomationEngine,
  getAutomationEngineIfRunning,
  shutdownAutomationEngine,
} from './instance'
export { clockInTimezone, collectWindowSignals, DeviceSignalReader } from './signals'
export type { SignalReader, SignalSnapshot } from './signals'
export { evaluateCondition } from './evaluator'
export { clamp, evaluateExpr } from './expressions'
export type { EvalContext } from './expressions'
export { WindowStore } from './windows'
export type {
  Action,
  AutomationRule,
  Condition,
  Expr,
  RunOutcome,
  Side,
  Trigger,
} from './types'
