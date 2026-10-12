/**
 * Pure helpers for the Sleep stages editor: labels and colours per stage,
 * value formatting, the rules the quick-adjust sliders drive, and how the
 * transition constraints read as a sentence.
 */
import {
  STAGE_METRIC_LABELS,
  STAGE_METRIC_UNITS,
  type StageMetric,
  type StageRule,
  type StageRuleset,
  type StageTransition,
} from '@/src/lib/sleep-stage-rules'
import type { SleepStage } from '@/src/lib/sleep-stages'

export const STAGE_LABELS: Record<SleepStage, string> = { wake: 'Wake', light: 'Light', deep: 'Deep', rem: 'REM' }

/** CSS colour of a stage (the chart tokens key awake, the classifier keys wake). */
export const STAGE_COLOR: Record<SleepStage, string> = {
  wake: 'var(--stage-awake)',
  rem: 'var(--stage-rem)',
  light: 'var(--stage-light)',
  deep: 'var(--stage-deep)',
}

/** Metric names as they read mid-sentence ("movement > 200", "HR ratio < 0.92"). */
export const METRIC_WORD: Record<StageMetric, string> = {
  hrRatio: 'HR ratio',
  heartRate: 'heart rate',
  hrv: 'HRV',
  breathingRate: 'breathing',
  movement: 'movement',
}

export const OP_WORD: Record<StageRule['when'][number]['op'], string> = { '<': '<', '<=': '≤', '>': '>', '>=': '≥' }

/** A threshold as the sentence shows it: "0.92", "25 ms". */
export function formatMetricValue(metric: StageMetric, value: number): string {
  const n = metric === 'hrRatio' ? value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') : String(Math.round(value * 100) / 100)
  const unit = STAGE_METRIC_UNITS[metric]
  return unit ? `${n} ${unit}` : n
}

/** "0–412", "0.86–1.08" */
export function formatMetricRange(metric: StageMetric, range: { min: number, max: number } | null): string | null {
  if (!range) return null
  const f = (v: number) => (metric === 'hrRatio' ? v.toFixed(2) : String(Math.round(v)))
  return `${f(range.min)}–${f(range.max)}`
}

export { STAGE_METRIC_LABELS }

export const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0)

/** Signed minutes: "+12 min", "−5 min", "±0 min". */
export function formatSignedMinutes(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  const sign = minutes > 0 ? '+' : minutes < 0 ? '−' : '±'
  return `${sign}${Math.abs(minutes)} min`
}

export interface QuickAdjust {
  /** Index in `ruleset.rules`. */
  rule: number
  /** Index in that rule's `when`. */
  condition: number
  metric: StageMetric
  value: number
}

/**
 * The condition a quick-adjust slider moves: the first rule for `stage`
 * with a condition on `metric`. Null when the ruleset has none, in which
 * case the slider is hidden.
 */
export function findQuickAdjust(ruleset: StageRuleset, stage: SleepStage, metric: StageMetric): QuickAdjust | null {
  for (let r = 0; r < ruleset.rules.length; r++) {
    const rule = ruleset.rules[r]
    if (rule.stage !== stage) continue
    const k = rule.when.findIndex(c => c.metric === metric)
    if (k >= 0) return { rule: r, condition: k, metric, value: rule.when[k].value }
  }
  return null
}

export function withConditionValue(ruleset: StageRuleset, target: QuickAdjust, value: number): StageRuleset {
  return {
    ...ruleset,
    rules: ruleset.rules.map((rule, r) => (r === target.rule
      ? { ...rule, when: rule.when.map((c, k) => (k === target.condition ? { ...c, value } : c)) }
      : rule)),
  }
}

export interface TransitionGroup {
  a: SleepStage
  b: SleepStage
  via: SleepStage
  /** Both directions are constrained ("between A and B") rather than one ("from A to B"). */
  pair: boolean
  /** Indexes in `transitions` that make up this group. */
  indexes: number[]
}

/**
 * Pair up `from → to` with its reverse when both exist with the same `via`,
 * so "wake→deep via light" + "deep→wake via light" read as one item.
 */
export function groupTransitions(transitions: StageTransition[]): TransitionGroup[] {
  const used = new Set<number>()
  const groups: TransitionGroup[] = []
  transitions.forEach((t, i) => {
    if (used.has(i)) return
    used.add(i)
    const j = transitions.findIndex((u, k) => !used.has(k) && u.from === t.to && u.to === t.from && u.via === t.via)
    if (j >= 0) {
      used.add(j)
      groups.push({ a: t.from, b: t.to, via: t.via, pair: true, indexes: [i, j] })
    }
    else {
      groups.push({ a: t.from, b: t.to, via: t.via, pair: false, indexes: [i] })
    }
  })
  return groups
}

/** The first symmetric pair not yet constrained, defaulting to wake ↔ deep via light. */
export function nextTransitionPair(transitions: StageTransition[]): [StageTransition, StageTransition] {
  const candidates: [SleepStage, SleepStage][] = [['wake', 'deep'], ['deep', 'rem'], ['wake', 'rem'], ['light', 'deep'], ['light', 'rem'], ['wake', 'light']]
  const has = (from: SleepStage, to: SleepStage) => transitions.some(t => t.from === from && t.to === to)
  const [a, b] = candidates.find(([x, y]) => !has(x, y) && !has(y, x)) ?? ['wake', 'deep']
  const via: SleepStage = a === 'light' || b === 'light' ? 'wake' : 'light'
  return [{ from: a, to: b, via }, { from: b, to: a, via }]
}

/** "Oct 9" */
export const shortDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
