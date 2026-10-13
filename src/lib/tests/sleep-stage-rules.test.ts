import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STAGE_CLASSIFIER,
  DEFAULT_STAGE_RULESET,
  describeCondition,
  describeRulesetChange,
  MOVEMENT_ONLY_STAGE_RULESET,
  resolveStageClassifier,
  STAGE_RULESET_PRESETS,
  stageClassifierSchema,
  stageRulesetSchema,
  summarizeRulesetChange,
  type StageRuleset,
} from '../sleep-stage-rules'

describe('stage rulesets', () => {
  it('ships presets that pass their own validation', () => {
    for (const preset of Object.values(STAGE_RULESET_PRESETS)) {
      expect(stageRulesetSchema.safeParse(preset.ruleset).success).toBe(true)
    }
  })

  it('rejects an inverted outlier range', () => {
    const bad = { ...DEFAULT_STAGE_RULESET, outliers: { ...DEFAULT_STAGE_RULESET.outliers, hrv: { min: 300, max: 1 } } }
    expect(stageRulesetSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects unknown metrics, operators, stages and extra keys', () => {
    const rule = (when: unknown, stage: unknown = 'wake') => ({ ...DEFAULT_STAGE_RULESET, rules: [{ stage, when: [when] }] })
    expect(stageRulesetSchema.safeParse(rule({ metric: 'spo2', op: '<', value: 1 })).success).toBe(false)
    expect(stageRulesetSchema.safeParse(rule({ metric: 'hrv', op: '==', value: 1 })).success).toBe(false)
    expect(stageRulesetSchema.safeParse(rule({ metric: 'hrv', op: '<', value: 1 }, 'n3')).success).toBe(false)
    expect(stageRulesetSchema.safeParse(rule({ metric: 'hrv', op: '<', value: Number.NaN })).success).toBe(false)
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, script: 'x' }).success).toBe(false)
  })

  it('caps rule, condition and transition counts', () => {
    const condition = { metric: 'hrv', op: '<', value: 1 }
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, rules: [{ stage: 'wake', when: Array(9).fill(condition) }] }).success).toBe(false)
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, rules: Array(33).fill({ stage: 'wake', when: [] }) }).success).toBe(false)
    expect(stageRulesetSchema.safeParse({ ...DEFAULT_STAGE_RULESET, transitions: Array(17).fill({ from: 'wake', to: 'deep', via: 'light' }) }).success).toBe(false)
  })

  it('only accepts known engines', () => {
    expect(stageClassifierSchema.safeParse(DEFAULT_STAGE_CLASSIFIER).success).toBe(true)
    expect(stageClassifierSchema.safeParse({ engine: 'neural', ruleset: DEFAULT_STAGE_RULESET }).success).toBe(false)
  })

  it('movement-only ignores heart signals and never enters low-signal mode', () => {
    expect(MOVEMENT_ONLY_STAGE_RULESET.rules.flatMap(r => r.when.map(c => c.metric))).toEqual(['movement'])
    expect(MOVEMENT_ONLY_STAGE_RULESET.lowSignalBelow).toBe(0)
  })
})

describe('resolveStageClassifier', () => {
  it('uses the defaults for nothing stored or an invalid stored value', () => {
    expect(resolveStageClassifier(null)).toBe(DEFAULT_STAGE_CLASSIFIER)
    expect(resolveStageClassifier(undefined)).toBe(DEFAULT_STAGE_CLASSIFIER)
    expect(resolveStageClassifier({ engine: 'rules', ruleset: { rules: [] } })).toBe(DEFAULT_STAGE_CLASSIFIER)
  })

  it('returns a valid stored classifier', () => {
    const stored = { engine: 'rules', ruleset: MOVEMENT_ONLY_STAGE_RULESET }
    expect(resolveStageClassifier(stored)).toEqual(stored)
  })
})

describe('describeCondition', () => {
  it('labels the metric and appends its unit', () => {
    expect(describeCondition({ metric: 'hrRatio', op: '<', value: 0.92 })).toBe('HR ratio < 0.92')
    expect(describeCondition({ metric: 'heartRate', op: '>=', value: 80 })).toBe('Heart rate >= 80 bpm')
    expect(describeCondition({ metric: 'movement', op: '>', value: 200 })).toBe('Movement > 200')
  })
})

describe('describeRulesetChange', () => {
  const base = DEFAULT_STAGE_RULESET

  it('names a moved threshold with its unit', () => {
    const after: StageRuleset = {
      ...base,
      rules: base.rules.map((r, i) => (i === 0 ? { ...r, when: [{ ...r.when[0], value: 240 }] } : i === 2 ? { ...r, when: r.when.map((c, k) => (k === 1 ? { ...c, value: 20 } : c)) } : r)),
    }
    expect(describeRulesetChange(base, after)).toEqual(['Wake movement 200 → 240', 'REM HRV 25 → 20 ms'])
    expect(summarizeRulesetChange(base, after)).toBe('Wake movement 200 → 240 +1 more')
  })

  it('describes added and removed rules, conditions and the rest of the ruleset', () => {
    const after: StageRuleset = {
      ...base,
      rules: [...base.rules.slice(0, 4), { stage: 'rem', when: [] }],
      fallback: 'deep',
      outliers: { ...base.outliers, heartRate: { min: 40, max: 130 }, heartRateSpikeStdDevs: 3 },
      lowSignalBelow: 0.4,
      smoothIsolatedEpochs: false,
      transitions: base.transitions.slice(0, 2),
    }
    expect(describeRulesetChange(base, after)).toEqual([
      'Rule 5: Wake → REM',
      'Wake: removed hr ratio >= 0.95',
      'Wake: removed movement > 100',
      'Otherwise Light → Deep',
      'Heart rate limits 45–130 → 40–130 bpm',
      'HR spike filter 2 → 3 SD',
      'Low signal below 0.3 → 0.4',
      'Smoothing off',
      'Transitions 4 → 2',
    ])
    expect(describeRulesetChange(base, { ...base, rules: [...base.rules, { stage: 'deep', when: [] }] })).toEqual(['Added rule 6: Deep'])
    expect(describeRulesetChange(base, MOVEMENT_ONLY_STAGE_RULESET)[0]).toBe('Removed rule 2: Deep')
    expect(summarizeRulesetChange(base, base)).toBe('No change')
  })
})

describe('describeRulesetChange — every kind of difference', () => {
  const base = DEFAULT_STAGE_RULESET
  const withRule = (i: number, patch: (r: StageRuleset['rules'][number]) => StageRuleset['rules'][number]): StageRuleset => ({
    ...base,
    rules: base.rules.map((r, k) => (k === i ? patch(r) : r)),
  })

  it('shows both conditions when the operator or the metric changes', () => {
    const op = withRule(1, r => ({ ...r, when: [{ ...r.when[0], op: '<=' }] }))
    expect(describeRulesetChange(base, op)).toEqual(['Deep: HR ratio < 0.92 → HR ratio <= 0.92'])
    const metric = withRule(0, r => ({ ...r, when: [{ ...r.when[0], metric: 'heartRate' }] }))
    expect(describeRulesetChange(base, metric)).toEqual(['Wake: Movement > 200 → Heart rate > 200 bpm'])
    expect(summarizeRulesetChange(base, metric)).toBe('Wake: Movement > 200 → Heart rate > 200 bpm')
  })

  it('names an added condition under the rule it joins', () => {
    const added = withRule(0, r => ({ ...r, when: [...r.when, { metric: 'hrRatio', op: '<', value: 1 }] }))
    expect(describeRulesetChange(base, added)).toEqual(['Wake: added hr ratio < 1'])
  })

  it('reports a moved value without a unit for unit-less metrics', () => {
    const ratio = withRule(1, r => ({ ...r, when: [{ ...r.when[0], value: 0.9 }] }))
    expect(describeRulesetChange(base, ratio)).toEqual(['Deep HR ratio 0.92 → 0.9'])
  })

  it('reports HRV and breathing limits with their units', () => {
    const after: StageRuleset = {
      ...base,
      outliers: { ...base.outliers, hrv: { min: 5, max: 300 }, breathingRate: { min: 8, max: 30 } },
    }
    expect(describeRulesetChange(base, after)).toEqual([
      'HRV limits 1–300 → 5–300 ms',
      'Breathing limits 8–25 → 8–30 br/min',
    ])
  })

  it('describes low-signal rule changes with their own label', () => {
    const stage: StageRuleset = { ...base, lowSignalRules: [{ ...base.lowSignalRules[0], stage: 'light' }] }
    expect(describeRulesetChange(base, stage)).toEqual(['Low-signal rule 1: Wake → Light'])
    const removed: StageRuleset = { ...base, lowSignalRules: [] }
    expect(describeRulesetChange(base, removed)).toEqual(['Removed low-signal rule 1: Wake'])
    const added: StageRuleset = { ...base, lowSignalRules: [...base.lowSignalRules, { stage: 'light', when: [] }] }
    expect(describeRulesetChange(base, added)).toEqual(['Added low-signal rule 2: Light'])
  })

  it('reports smoothing turned on and a reordered transition list of the same length', () => {
    const off: StageRuleset = { ...base, smoothIsolatedEpochs: false }
    expect(describeRulesetChange(off, base)).toEqual(['Smoothing on'])
    expect(summarizeRulesetChange(off, base)).toBe('Smoothing on')
    const reordered: StageRuleset = { ...base, transitions: [...base.transitions].reverse() }
    expect(describeRulesetChange(base, reordered)).toEqual(['Transitions 4 → 4'])
  })

  it('reports nothing for an identical ruleset', () => {
    expect(describeRulesetChange(base, { ...base, rules: base.rules.map(r => ({ ...r, when: r.when.map(c => ({ ...c })) })) })).toEqual([])
  })
})
