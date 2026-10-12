import { describe, expect, it } from 'vitest'
import { DEFAULT_STAGE_RULESET, type StageRuleset, type StageTransition } from '@/src/lib/sleep-stage-rules'
import {
  findQuickAdjust,
  formatMetricRange,
  formatMetricValue,
  formatSignedMinutes,
  groupTransitions,
  nextTransitionPair,
  pct,
  shortDate,
  withConditionValue,
} from '../sleepStageEditing'

describe('formatMetricValue', () => {
  it('trims trailing zeros from an HR ratio but keeps three significant decimals', () => {
    expect(formatMetricValue('hrRatio', 0.9)).toBe('0.9')
    expect(formatMetricValue('hrRatio', 0.925)).toBe('0.925')
    expect(formatMetricValue('hrRatio', 1)).toBe('1')
  })

  it('rounds other metrics to two decimals and appends a unit when the metric has one', () => {
    expect(formatMetricValue('heartRate', 72.456)).toBe('72.46 bpm')
    expect(formatMetricValue('hrv', 25)).toBe('25 ms')
    expect(formatMetricValue('movement', 200)).toBe('200')
  })
})

describe('formatMetricRange', () => {
  it('is null without a range', () => {
    expect(formatMetricRange('movement', null)).toBeNull()
  })

  it('shows two decimals for an HR ratio and whole numbers otherwise', () => {
    expect(formatMetricRange('hrRatio', { min: 0.861, max: 1.08 })).toBe('0.86–1.08')
    expect(formatMetricRange('movement', { min: 0.4, max: 412.6 })).toBe('0–413')
  })
})

describe('pct', () => {
  it('rounds a share to whole percent and is 0 for an empty total', () => {
    expect(pct(1, 4)).toBe(25)
    expect(pct(2, 3)).toBe(67)
    expect(pct(1, 0)).toBe(0)
  })
})

describe('formatSignedMinutes', () => {
  it('signs positive, negative and zero minutes', () => {
    expect(formatSignedMinutes(12 * 60_000)).toBe('+12 min')
    expect(formatSignedMinutes(-5 * 60_000)).toBe('−5 min')
    expect(formatSignedMinutes(0)).toBe('±0 min')
    expect(formatSignedMinutes(20_000)).toBe('±0 min')
  })
})

describe('findQuickAdjust', () => {
  it('finds the first rule for the stage with a condition on the metric', () => {
    expect(findQuickAdjust(DEFAULT_STAGE_RULESET, 'wake', 'movement')).toEqual({ rule: 0, condition: 0, metric: 'movement', value: 200 })
    expect(findQuickAdjust(DEFAULT_STAGE_RULESET, 'rem', 'hrv')).toEqual({ rule: 2, condition: 1, metric: 'hrv', value: 25 })
    expect(findQuickAdjust(DEFAULT_STAGE_RULESET, 'wake', 'hrRatio')).toEqual({ rule: 4, condition: 0, metric: 'hrRatio', value: 0.95 })
  })

  it('is null when no rule for the stage tests the metric', () => {
    expect(findQuickAdjust(DEFAULT_STAGE_RULESET, 'deep', 'movement')).toBeNull()
    expect(findQuickAdjust(DEFAULT_STAGE_RULESET, 'light', 'movement')).toBeNull()
    expect(findQuickAdjust({ ...DEFAULT_STAGE_RULESET, rules: [] }, 'wake', 'movement')).toBeNull()
  })
})

describe('withConditionValue', () => {
  it('replaces only the targeted condition and leaves other rules untouched', () => {
    const target = { rule: 2, condition: 1, metric: 'hrv' as const, value: 25 }
    const next: StageRuleset = withConditionValue(DEFAULT_STAGE_RULESET, target, 30)
    expect(next.rules[2].when[1]).toEqual({ metric: 'hrv', op: '<', value: 30 })
    expect(next.rules[2].when[0]).toBe(DEFAULT_STAGE_RULESET.rules[2].when[0])
    expect(next.rules[0]).toBe(DEFAULT_STAGE_RULESET.rules[0])
    expect(next.rules[3]).toBe(DEFAULT_STAGE_RULESET.rules[3])
    expect(DEFAULT_STAGE_RULESET.rules[2].when[1].value).toBe(25)
  })
})

describe('groupTransitions', () => {
  it('pairs a transition with its reverse when both share a via', () => {
    expect(groupTransitions(DEFAULT_STAGE_RULESET.transitions)).toEqual([
      { a: 'wake', b: 'deep', via: 'light', pair: true, indexes: [0, 1] },
      { a: 'deep', b: 'rem', via: 'light', pair: true, indexes: [2, 3] },
    ])
  })

  it('keeps a one-way transition, and a reverse with a different via, as singles', () => {
    const transitions: StageTransition[] = [
      { from: 'wake', to: 'rem', via: 'light' },
      { from: 'rem', to: 'wake', via: 'deep' },
      { from: 'light', to: 'deep', via: 'wake' },
    ]
    expect(groupTransitions(transitions)).toEqual([
      { a: 'wake', b: 'rem', via: 'light', pair: false, indexes: [0] },
      { a: 'rem', b: 'wake', via: 'deep', pair: false, indexes: [1] },
      { a: 'light', b: 'deep', via: 'wake', pair: false, indexes: [2] },
    ])
    expect(groupTransitions([])).toEqual([])
  })
})

describe('nextTransitionPair', () => {
  it('starts with wake and deep via light', () => {
    expect(nextTransitionPair([])).toEqual([
      { from: 'wake', to: 'deep', via: 'light' },
      { from: 'deep', to: 'wake', via: 'light' },
    ])
  })

  it('skips pairs constrained in either direction', () => {
    expect(nextTransitionPair(DEFAULT_STAGE_RULESET.transitions)).toEqual([
      { from: 'wake', to: 'rem', via: 'light' },
      { from: 'rem', to: 'wake', via: 'light' },
    ])
    expect(nextTransitionPair([{ from: 'deep', to: 'wake', via: 'light' }])[0]).toEqual({ from: 'deep', to: 'rem', via: 'light' })
  })

  it('goes via wake when the pair involves light', () => {
    const taken: StageTransition[] = [
      { from: 'wake', to: 'deep', via: 'light' },
      { from: 'deep', to: 'rem', via: 'light' },
      { from: 'wake', to: 'rem', via: 'light' },
    ]
    expect(nextTransitionPair(taken)).toEqual([
      { from: 'light', to: 'deep', via: 'wake' },
      { from: 'deep', to: 'light', via: 'wake' },
    ])
  })

  it('falls back to wake and deep when every candidate is taken', () => {
    const all: StageTransition[] = [
      { from: 'wake', to: 'deep', via: 'light' },
      { from: 'deep', to: 'rem', via: 'light' },
      { from: 'wake', to: 'rem', via: 'light' },
      { from: 'light', to: 'deep', via: 'wake' },
      { from: 'light', to: 'rem', via: 'wake' },
      { from: 'wake', to: 'light', via: 'wake' },
    ]
    expect(nextTransitionPair(all)).toEqual([
      { from: 'wake', to: 'deep', via: 'light' },
      { from: 'deep', to: 'wake', via: 'light' },
    ])
  })
})

describe('shortDate', () => {
  it('shows the month and day only', () => {
    const ms = Date.UTC(2026, 9, 9, 12)
    expect(shortDate(ms)).toBe(new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))
    expect(shortDate(ms)).toMatch(/9/)
    expect(shortDate(ms)).not.toMatch(/2026/)
  })
})
