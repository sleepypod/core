/**
 * Sleep stage classification rules as data.
 *
 * The classifier in sleep-stages.ts evaluates a StageRuleset: ordered
 * first-match rules over per-epoch metrics, then smoothing and transition
 * constraints. DEFAULT_STAGE_RULESET reproduces the iOS SleepAnalyzer port;
 * a side may store its own ruleset, validated by stageClassifierSchema at the
 * API boundary. Stages are classified on read, so a changed ruleset re-scores
 * every stored night.
 */
import { z } from 'zod'

export const SLEEP_STAGES = ['wake', 'light', 'deep', 'rem'] as const

/**
 * Per-epoch inputs a rule can test. hrRatio is the epoch's heart rate over
 * the night's mean heart rate. A condition on a metric the epoch lacks
 * (null) never matches.
 */
export const STAGE_METRICS = ['hrRatio', 'heartRate', 'hrv', 'breathingRate', 'movement'] as const
export type StageMetric = typeof STAGE_METRICS[number]

export const STAGE_OPERATORS = ['<', '<=', '>', '>='] as const
export type StageOperator = typeof STAGE_OPERATORS[number]

export const STAGE_METRIC_LABELS: Record<StageMetric, string> = {
  hrRatio: 'HR ratio',
  heartRate: 'Heart rate',
  hrv: 'HRV',
  breathingRate: 'Breathing rate',
  movement: 'Movement',
}

export const STAGE_METRIC_UNITS: Record<StageMetric, string> = {
  hrRatio: '',
  heartRate: 'bpm',
  hrv: 'ms',
  breathingRate: 'br/min',
  movement: '',
}

const stageSchema = z.enum(SLEEP_STAGES)
const finite = z.number().finite()

const rangeSchema = z.object({ min: finite, max: finite }).strict()
  .refine(r => r.min <= r.max, { message: 'min must be less than or equal to max' })

export const stageConditionSchema = z.object({
  metric: z.enum(STAGE_METRICS),
  op: z.enum(STAGE_OPERATORS),
  value: finite,
}).strict()

/** Matches when every condition holds. An empty `when` always matches. */
export const stageRuleSchema = z.object({
  stage: stageSchema,
  when: z.array(stageConditionSchema).max(8),
}).strict()

export const stageTransitionSchema = z.object({
  from: stageSchema,
  to: stageSchema,
  via: stageSchema,
}).strict()

export const stageRulesetSchema = z.object({
  /** Readings outside these limits are dropped (set to null) before classifying. */
  outliers: z.object({
    heartRate: rangeSchema,
    hrv: rangeSchema,
    breathingRate: rangeSchema,
    /** Drop a heart rate this many standard deviations from its 5-sample median; 0 disables. */
    heartRateSpikeStdDevs: finite.min(0).max(10),
  }).strict(),
  /** Below this piezo calibration quality, `lowSignalRules` replace `rules`. */
  lowSignalBelow: finite.min(0).max(1),
  lowSignalRules: z.array(stageRuleSchema).max(32),
  rules: z.array(stageRuleSchema).max(32),
  /** Stage for an epoch no rule matches. */
  fallback: stageSchema,
  /** Replace a single epoch that differs from two matching neighbours (A-B-A → A-A-A). */
  smoothIsolatedEpochs: z.boolean(),
  /** A `from` epoch followed by a `to` epoch becomes `via` instead. */
  transitions: z.array(stageTransitionSchema).max(16),
}).strict()

export type StageCondition = z.infer<typeof stageConditionSchema>
export type StageRule = z.infer<typeof stageRuleSchema>
export type StageTransition = z.infer<typeof stageTransitionSchema>
export type StageRuleset = z.infer<typeof stageRulesetSchema>

/**
 * How a side's stages are classified. `engine` selects the classifier; the
 * only engine today evaluates a ruleset. A stored null means the defaults.
 */
export const stageClassifierSchema = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('rules'), ruleset: stageRulesetSchema }).strict(),
])
export type StageClassifier = z.infer<typeof stageClassifierSchema>
export type StageEngine = StageClassifier['engine']

export const STAGE_ENGINES: Record<StageEngine, { label: string, description: string }> = {
  rules: {
    label: 'Rules',
    description: 'Ordered threshold rules over heart rate, HRV, breathing and movement',
  },
}

/** The iOS SleepAnalyzer port the pod has always used. */
export const DEFAULT_STAGE_RULESET: StageRuleset = {
  outliers: {
    heartRate: { min: 45, max: 130 },
    hrv: { min: 1, max: 300 },
    breathingRate: { min: 8, max: 25 },
    heartRateSpikeStdDevs: 2,
  },
  lowSignalBelow: 0.3,
  lowSignalRules: [
    { stage: 'wake', when: [{ metric: 'movement', op: '>', value: 200 }] },
  ],
  rules: [
    { stage: 'wake', when: [{ metric: 'movement', op: '>', value: 200 }] },
    { stage: 'deep', when: [{ metric: 'hrRatio', op: '<', value: 0.92 }] },
    {
      stage: 'rem',
      when: [
        { metric: 'hrRatio', op: '>=', value: 0.95 },
        { metric: 'hrv', op: '<', value: 25 },
        { metric: 'movement', op: '<', value: 30 },
      ],
    },
    {
      stage: 'rem',
      when: [
        { metric: 'hrRatio', op: '>=', value: 0.95 },
        { metric: 'movement', op: '<', value: 50 },
        { metric: 'hrv', op: '<', value: 40 },
      ],
    },
    {
      stage: 'wake',
      when: [
        { metric: 'hrRatio', op: '>=', value: 0.95 },
        { metric: 'movement', op: '>', value: 100 },
      ],
    },
  ],
  fallback: 'light',
  smoothIsolatedEpochs: true,
  transitions: [
    { from: 'wake', to: 'deep', via: 'light' },
    { from: 'deep', to: 'wake', via: 'light' },
    { from: 'deep', to: 'rem', via: 'light' },
    { from: 'rem', to: 'deep', via: 'light' },
  ],
}

/** Movement only (actigraphy): ignores heart signals entirely. */
export const MOVEMENT_ONLY_STAGE_RULESET: StageRuleset = {
  ...DEFAULT_STAGE_RULESET,
  lowSignalBelow: 0,
  rules: DEFAULT_STAGE_RULESET.lowSignalRules,
}

export const STAGE_RULESET_PRESETS = {
  default: { label: 'Default', description: 'Heart rate, HRV and movement (iOS SleepAnalyzer port)', ruleset: DEFAULT_STAGE_RULESET },
  movementOnly: { label: 'Movement only', description: 'Wake or light from movement alone, ignoring heart signals', ruleset: MOVEMENT_ONLY_STAGE_RULESET },
} as const satisfies Record<string, { label: string, description: string, ruleset: StageRuleset }>
export type StageRulesetPreset = keyof typeof STAGE_RULESET_PRESETS

export const DEFAULT_STAGE_CLASSIFIER: StageClassifier = { engine: 'rules', ruleset: DEFAULT_STAGE_RULESET }

/**
 * The classifier a side uses: its stored one, or the defaults when it has
 * none. A stored value that no longer validates also falls back, so a schema
 * change can never break stage reads.
 */
export function resolveStageClassifier(stored: unknown): StageClassifier {
  if (stored == null) return DEFAULT_STAGE_CLASSIFIER
  const parsed = stageClassifierSchema.safeParse(stored)
  return parsed.success ? parsed.data : DEFAULT_STAGE_CLASSIFIER
}

/** "HR ratio < 0.92" */
export function describeCondition(c: StageCondition): string {
  const unit = STAGE_METRIC_UNITS[c.metric]
  return `${STAGE_METRIC_LABELS[c.metric]} ${c.op} ${c.value}${unit ? ` ${unit}` : ''}`
}

const STAGE_NAMES: Record<SleepStageName, string> = { wake: 'Wake', light: 'Light', deep: 'Deep', rem: 'REM' }
type SleepStageName = typeof SLEEP_STAGES[number]

/** "Wake movement 200 → 240": the first thing that differs, for a change log. */
export function describeRulesetChange(before: StageRuleset, after: StageRuleset): string[] {
  const out: string[] = []
  const range = (r: { min: number, max: number }) => `${r.min}–${r.max}`
  const stageName = (s: SleepStageName) => STAGE_NAMES[s]
  const metric = (m: StageMetric) => STAGE_METRIC_LABELS[m].toLowerCase().replace('hr ratio', 'HR ratio').replace('hrv', 'HRV')

  const diffRules = (a: StageRule[], b: StageRule[], label: string) => {
    const n = Math.max(a.length, b.length)
    for (let i = 0; i < n; i++) {
      const ra = a[i]
      const rb = b[i]
      if (!ra || !rb) {
        if (rb) out.push(`Added ${label} ${i + 1}: ${stageName(rb.stage)}`)
        if (ra) out.push(`Removed ${label} ${i + 1}: ${stageName(ra.stage)}`)
        continue
      }
      if (ra.stage !== rb.stage) out.push(`${label[0].toUpperCase()}${label.slice(1)} ${i + 1}: ${stageName(ra.stage)} → ${stageName(rb.stage)}`)
      const m = Math.max(ra.when.length, rb.when.length)
      for (let k = 0; k < m; k++) {
        const ca = ra.when[k]
        const cb = rb.when[k]
        if (!ca || !cb) {
          if (cb) out.push(`${stageName(rb.stage)}: added ${describeCondition(cb).toLowerCase()}`)
          if (ca) out.push(`${stageName(ra.stage)}: removed ${describeCondition(ca).toLowerCase()}`)
          continue
        }
        if (ca.metric !== cb.metric || ca.op !== cb.op) {
          out.push(`${stageName(rb.stage)}: ${describeCondition(ca)} → ${describeCondition(cb)}`)
        }
        else if (ca.value !== cb.value) {
          const unit = STAGE_METRIC_UNITS[cb.metric]
          out.push(`${stageName(rb.stage)} ${metric(cb.metric)} ${ca.value} → ${cb.value}${unit ? ` ${unit}` : ''}`)
        }
      }
    }
  }

  diffRules(before.rules, after.rules, 'rule')
  if (before.fallback !== after.fallback) out.push(`Otherwise ${stageName(before.fallback)} → ${stageName(after.fallback)}`)
  const oa = before.outliers
  const ob = after.outliers
  if (range(oa.heartRate) !== range(ob.heartRate)) out.push(`Heart rate limits ${range(oa.heartRate)} → ${range(ob.heartRate)} bpm`)
  if (range(oa.hrv) !== range(ob.hrv)) out.push(`HRV limits ${range(oa.hrv)} → ${range(ob.hrv)} ms`)
  if (range(oa.breathingRate) !== range(ob.breathingRate)) out.push(`Breathing limits ${range(oa.breathingRate)} → ${range(ob.breathingRate)} br/min`)
  if (oa.heartRateSpikeStdDevs !== ob.heartRateSpikeStdDevs) out.push(`HR spike filter ${oa.heartRateSpikeStdDevs} → ${ob.heartRateSpikeStdDevs} SD`)
  if (before.lowSignalBelow !== after.lowSignalBelow) out.push(`Low signal below ${before.lowSignalBelow} → ${after.lowSignalBelow}`)
  diffRules(before.lowSignalRules, after.lowSignalRules, 'low-signal rule')
  if (before.smoothIsolatedEpochs !== after.smoothIsolatedEpochs) out.push(`Smoothing ${after.smoothIsolatedEpochs ? 'on' : 'off'}`)
  if (JSON.stringify(before.transitions) !== JSON.stringify(after.transitions)) {
    out.push(`Transitions ${before.transitions.length} → ${after.transitions.length}`)
  }
  return out
}

/** One line for a change log: the first difference, plus how many more. */
export function summarizeRulesetChange(before: StageRuleset, after: StageRuleset): string {
  const changes = describeRulesetChange(before, after)
  if (changes.length === 0) return 'No change'
  return changes.length === 1 ? changes[0] : `${changes[0]} +${changes.length - 1} more`
}
