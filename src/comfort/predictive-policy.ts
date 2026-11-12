import type { Side } from '@/src/hardware/types'
import { boundedComfortTarget, decideComfort, DEVICE_MAX_AGE_MS, type ComfortContext, type ComfortState } from './policy'
import { predictiveHorizonsSchema, predictiveTargetPreviewSchema, type PredictiveTargetPreview } from './predictive-contract'

interface Prediction { predictions: unknown, reason: string }
type Comparison = PredictiveTargetPreview['comparisons'][number]
const HORIZON_MS = 30 * 60_000
const CHANGE_COST_F = 0.25
const MINIMUM_ADVANTAGE_F = 0.25

/** Score distance from the approved water target, never inferred body temperature or sleep benefit. */
function compare(targetF: number, kind: Comparison['kind'], result: Prediction, desiredF: number): Comparison {
  const parsed = predictiveHorizonsSchema.safeParse(result.predictions)
  if (!parsed.success) return { targetF, kind, predictions: [], bestErrorF: null, worstErrorF: null, reason: result.reason }
  const best = parsed.data.map(value => Math.max(value.lowerF - desiredF, desiredF - value.upperF, 0))
  const worst = parsed.data.map(value => Math.max(Math.abs(value.lowerF - desiredF), Math.abs(value.upperF - desiredF)))
  return { targetF, kind, predictions: parsed.data, bestErrorF: (best[0] + best[1]) / 2,
    worstErrorF: (worst[0] + worst[1]) / 2, reason: result.reason }
}

/** Research-only ranking. This module has no persistence, command authority, or hardware dependency. */
export function previewPredictiveTarget(input: {
  side: Side
  state: ComfortState
  context: ComfortContext
  hold: Prediction
  steps: Array<Prediction & { targetF: number }>
}): PredictiveTargetPreview {
  const { side, state, context } = input
  const current = context.device.targetF
  const base: PredictiveTargetPreview = {
    apiVersion: 1, policy: 'bounded-water-tracking-v1', side, generatedAt: context.now,
    mode: 'research_preview', activationAvailable: false, objective: 'bounded-routine-water-target',
    disposition: 'withheld', currentTargetF: Number.isInteger(current) && current !== null && current >= 55 && current <= 110 ? current : null,
    desiredWaterF: null, proposedTargetF: null, expiresAt: null, minimumF: null, maximumF: null,
    comparisons: [], reason: '',
  }
  const finish = (reason: string, change: Partial<PredictiveTargetPreview> = {}) => predictiveTargetPreviewSchema.parse({ ...base, ...change, reason })
  if (state.config.mode !== 'preview') return finish('Predictive comparison is available only in Preview. Your current controller keeps its authority.')
  const guard = decideComfort(state, context)
  if (!guard.eligible || guard.proposedF === null || !context.window || base.currentTargetF === null) return finish(guard.reason)
  const currentTargetF = base.currentTargetF
  const window = context.window
  if (window.phases?.changes.some(change => !Number.isSafeInteger(change.at) || change.at <= 0)) return finish('The routine change times could not be verified.')
  const boundary = Math.min(window.end, window.alarmAt === null ? window.end : window.alarmAt - HORIZON_MS,
    ...(window.phases?.changes.filter(change => change.at > context.now).map(change => change.at) ?? []))
  // A forecast across a routine change or wake warming would compare different objectives.
  if (context.now + HORIZON_MS >= boundary) return finish('The next routine change, wake warming or routine end is too close for a full 30-minute comparison.')
  const minimumF = Math.max(state.config.minimumF, (window.scheduledBaselineF ?? window.baselineF) - 3)
  const maximumF = Math.min(state.config.maximumF, (window.scheduledBaselineF ?? window.baselineF) + 3)
  if (base.currentTargetF < minimumF || base.currentTargetF > maximumF) return finish('The reported target is outside the bounded overnight range.')
  const desiredF = boundedComfortTarget(state, window.baselineF, context.bedroom?.offsetF ?? 0)
  if (desiredF < minimumF || desiredF > maximumF) return finish('The comfort objective falls outside the original routine offset budget.')
  const hold = compare(base.currentTargetF, 'hold', input.hold, desiredF)
  const allowed = [base.currentTargetF - 1, base.currentTargetF + 1].filter(target => target >= minimumF && target <= maximumF)
  if (input.steps.length > 2 || new Set(input.steps.map(step => step.targetF)).size !== input.steps.length
    || input.steps.some(step => !Number.isInteger(step.targetF) || Math.abs(step.targetF - currentTargetF) !== 1)) {
    return finish('The candidate set does not match this observed target. Refresh the comparison.')
  }
  const steps = allowed.map(target => compare(target, 'step', input.steps.find(step => step.targetF === target)
    ?? { predictions: [], reason: 'No supported response is available for this direction.' }, desiredF))
  const comparisons = [hold, ...steps]
  const details = { desiredWaterF: desiredF, minimumF, maximumF, comparisons }
  if (hold.predictions.length !== 2 || hold.bestErrorF === null) return finish('A current unchanged-target forecast is required before comparing a change.', details)
  // Require improvement even at the adverse ends of both empirical ranges; ties always hold.
  const wins = steps.filter(step => step.predictions.length === 2 && step.worstErrorF !== null
    && hold.predictions.every((steady, index) => {
      const candidate = step.predictions[index]
      const holdBest = Math.max(steady.lowerF - desiredF, desiredF - steady.upperF, 0)
      const stepWorst = Math.max(Math.abs(candidate.lowerF - desiredF), Math.abs(candidate.upperF - desiredF))
      return holdBest - stepWorst - CHANGE_COST_F >= MINIMUM_ADVANTAGE_F
    }))
  const selected = wins.length === 1 ? wins[0] : hold
  const expiresAt = Math.min(context.now + DEVICE_MAX_AGE_MS, (context.device.observedAt ?? 0) + DEVICE_MAX_AGE_MS,
    context.signals?.expiresAt ?? Infinity, context.bedroom?.expiresAt ?? Infinity)
  if (expiresAt <= context.now) return finish('The source readings expired during comparison. Read them again.', details)
  return finish(selected.kind === 'step'
    ? 'One nearby target has a better water-tracking range at both horizons, including a penalty for changing. This is an experiment candidate, not a comfort benefit or an applied adjustment.'
    : 'Keep the current target in this Preview. No unique small change clearly beats holding after accounting for forecast error and the cost of changing.',
  { ...details, disposition: selected.kind === 'step' ? 'candidate' : 'hold', proposedTargetF: selected.targetF, expiresAt })
}
