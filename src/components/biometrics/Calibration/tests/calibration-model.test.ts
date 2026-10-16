import { describe, expect, it } from 'vitest'
import { defaultConfig, type BiometricConfig } from '@/src/biometrics/algorithms/registry-core'
import {
  activityTime,
  actorOf,
  aggregate,
  barHeight,
  baselineLabel,
  changedPaths,
  clockLabel,
  compareTone,
  coverage,
  draftFrom,
  lifecycle,
  nightLabel,
  nightScores,
  overridesFor,
  paramDiffs,
  roundParam,
  runStatus,
  savedBacktest,
  shortDuration,
  stageOverrides,
  tracePath,
  traceTicks,
  type JobLike,
} from '../calibration-model'
import type { NumericReportView } from '../report-view'

const withConfig = (patch: (c: BiometricConfig) => void) => {
  const c = structuredClone(defaultConfig) as BiometricConfig
  patch(c)
  return c
}
const job = (over: Partial<JobLike>): JobLike => ({
  id: 'j', experimentId: 'e', datasetId: 'd', split: 'tuning', state: 'succeeded', createdAtMs: 0, updatedAtMs: 1000,
  configurations: [{ label: 'default', revisionId: null, hash: 'h-default' }, { label: 'current', revisionId: null, hash: 'h-current' }, { label: 'candidate', revisionId: 'saved', hash: 'h-saved' }],
  evaluationScope: 'retained_waveform_replay', ...over,
})

describe('draft and overrides', () => {
  it('reads the five tunable values and detects edits', () => {
    const draft = draftFrom(defaultConfig)
    expect(draft['heart_rate.trackingToleranceBpm']).toBe(15)
    expect(changedPaths(draft, defaultConfig)).toEqual([])
    expect(changedPaths({ ...draft, 'hrv_index.minimumWindows': 12 }, defaultConfig)).toEqual(['hrv_index.minimumWindows'])
  })

  it('trims slider float noise to the parameter precision', () => {
    expect(roundParam('breathing_rate.intervalLowerRatio', 0.1 + 0.2 + 0.15000000000000002)).toBe(0.45)
    expect(roundParam('heart_rate.trackingHistoryLength', 4.6)).toBe(5)
  })

  it('keeps unrelated overrides, replaces edited ones and drops values back at default', () => {
    const saved = [
      { path: 'sleep_stages.ruleset.rules.0.when.0.value', value: 240 },
      { path: 'heart_rate.trackingToleranceBpm', value: 12 },
    ]
    const draft = { ...draftFrom(defaultConfig), 'heart_rate.trackingToleranceBpm': 15, 'hrv_index.minimumWindows': 14 }
    expect(overridesFor(saved, draft, defaultConfig)).toEqual([
      { path: 'sleep_stages.ruleset.rules.0.when.0.value', value: 240 },
      { path: 'hrv_index.minimumWindows', value: 14 },
    ])
  })

  it('describes numeric changes as key old → new', () => {
    const after = withConfig((c) => {
      c.heart_rate.trackingToleranceBpm = 12
    })
    expect(paramDiffs(defaultConfig, after)).toEqual(['trackingToleranceBpm 15 → 12'])
  })
})

describe('actors and time', () => {
  it('classifies web, agent and pod requesters', () => {
    expect(actorOf('web-calibration')).toEqual({ kind: 'you', name: 'you' })
    expect(actorOf('tuner', 'agent')).toEqual({ kind: 'agent', name: 'tuner' })
    expect(actorOf('tuner')).toEqual({ kind: 'agent', name: 'tuner' })
    expect(actorOf('anything', 'migration').kind).toBe('pod')
    expect(actorOf('someone', 'manual').kind).toBe('you')
  })

  it('formats durations and relative times', () => {
    expect(shortDuration(38_000)).toBe('38 s')
    expect(shortDuration(14 * 60_000)).toBe('14 min')
    expect(shortDuration(3 * 3_600_000)).toBe('3 h')
    expect(shortDuration(3 * 86_400_000)).toBe('3 d')
    expect(activityTime(1000, 1000 + 16 * 60_000, 'UTC', false)).toBe('16 min ago')
    expect(activityTime(1000, 1000 + 10_000, 'UTC', false)).toBe('just now')
    expect(activityTime(Date.UTC(2026, 9, 9, 23, 43), Date.UTC(2026, 9, 12), 'UTC', false)).toBe('Oct 9 · 11:43 PM')
    expect(activityTime(Date.UTC(2026, 9, 9, 23, 43), Date.UTC(2026, 9, 12), 'UTC', true)).toBe('Oct 9 · 23:43')
  })

  it('labels clock ticks compactly in the device timezone', () => {
    expect(clockLabel(Date.UTC(2026, 9, 12, 6, 15), 'America/Los_Angeles', false)).toBe('11:15p')
    expect(clockLabel(Date.UTC(2026, 9, 12, 8, 0), 'America/Los_Angeles', false)).toBe('1a')
    expect(clockLabel(Date.UTC(2026, 9, 12, 8, 0), 'America/Los_Angeles', true)).toBe('01:00')
    expect(clockLabel(Date.UTC(2026, 9, 12, 8, 0), 'Not/AZone', true)).toBe('08:00')
  })
})

describe('lifecycle', () => {
  const now = 10 * 3_600_000
  const base = { nowMs: now, bindingUpdatedAtMs: now - 60_000, generation: 3, runtimeReported: true }

  it('shows a pending request with the processor still on the previous profile', () => {
    const strip = lifecycle({ ...base, saved: { actor: { kind: 'agent', name: 'tuner' }, atMs: now - 16 * 60_000 },
      request: { observedState: 'pending_boundary', createdAtMs: now - 14 * 60_000, updatedAtMs: now, previousIsDefaults: false } })
    expect(strip.saved).toEqual({ tone: 'ok', value: 'by tuner · 16 min ago' })
    expect(strip.requested).toEqual({ tone: 'warn', value: 'waiting 14 min' })
    expect(strip.processor).toEqual({ tone: 'ok', value: 'running previous' })
  })

  it('names system defaults when the previous profile was the shipped one', () => {
    const strip = lifecycle({ ...base, saved: { actor: { kind: 'you', name: 'you' }, atMs: now },
      request: { observedState: 'pending_delivery', createdAtMs: now, updatedAtMs: now, previousIsDefaults: true } })
    expect(strip.processor.value).toBe('running system defaults')
  })

  it('reports acknowledgement and failure', () => {
    const acked = lifecycle({ ...base, saved: null, request: { observedState: 'applied', createdAtMs: now - 120_000, updatedAtMs: now - 60_000, previousIsDefaults: false } })
    expect(acked.requested).toEqual({ tone: 'ok', value: 'acknowledged 1 min ago' })
    expect(acked.processor.value).toBe('running saved')
    expect(acked.saved.value).toBe('system defaults · 1 min ago')
    const failed = lifecycle({ ...base, saved: null, request: { observedState: 'failed', createdAtMs: now, updatedAtMs: now, previousIsDefaults: false } })
    expect(failed.requested.tone).toBe('danger')
    expect(failed.processor.tone).toBe('danger')
  })

  it('does not claim a running profile the processor never reported', () => {
    const fresh = lifecycle({ ...base, generation: 0, runtimeReported: false, saved: null, request: null })
    expect(fresh.saved.value).toBe('system defaults')
    expect(fresh.requested).toEqual({ tone: 'muted', value: 'none' })
    expect(fresh.processor).toEqual({ tone: 'muted', value: 'not reported' })
    expect(lifecycle({ ...base, saved: null, request: null }).processor.value).toBe('running system defaults')
  })
})

describe('sleep-stage overrides', () => {
  it('pairs changed condition values rule by rule', () => {
    const saved = withConfig((c) => {
      if (c.sleep_stages.engine === 'rules') c.sleep_stages.ruleset.rules[0].when[0].value = 240
    })
    const result = stageOverrides(defaultConfig.sleep_stages, saved.sleep_stages)
    expect(result.ruleCount).toBe(5)
    expect(result.restructured).toBe(false)
    expect(result.overrides).toEqual([{ rule: 1, stage: 'wake', metric: 'movement', op: '>', before: 200, after: 240 }])
  })

  it('flags a reshaped rule list instead of guessing pairs', () => {
    const saved = withConfig((c) => {
      if (c.sleep_stages.engine === 'rules') {
        c.sleep_stages.ruleset.rules.pop()
        c.sleep_stages.ruleset.fallback = 'deep'
      }
    })
    const result = stageOverrides(defaultConfig.sleep_stages, saved.sleep_stages)
    expect(result).toMatchObject({ ruleCount: 4, restructured: true, fallbackChanged: true, overrides: [] })
  })
})

describe('backtests', () => {
  it('groups the latest runs of the saved revision by split on one dataset', () => {
    const jobs = [
      job({ id: 'old-tuning', split: 'tuning', createdAtMs: 1 }),
      job({ id: 'tuning', split: 'tuning', createdAtMs: 5 }),
      job({ id: 'holdout', split: 'holdout', createdAtMs: 4 }),
      job({ id: 'failed-retry', split: 'holdout', createdAtMs: 6, state: 'failed' }),
      job({ id: 'other-dataset', datasetId: 'x', split: 'validation', createdAtMs: 2 }),
      job({ id: 'other-revision', split: 'validation', createdAtMs: 9, configurations: [{ label: 'candidate', revisionId: 'other', hash: 'z' }] }),
    ]
    const group = savedBacktest(jobs, 'saved')
    expect(group?.latest.id).toBe('failed-retry')
    expect(group?.bySplit.tuning?.id).toBe('tuning')
    expect(group?.bySplit.holdout?.id).toBe('holdout')
    expect(group?.bySplit.validation).toBeUndefined()
    expect(savedBacktest(jobs, null)).toBeNull()
    expect(savedBacktest(jobs, 'missing')).toBeNull()
  })
  it('stands in a run that resolves to the saved configuration when the saved profile is system defaults', () => {
    const jobs = [job({ id: 'defaults-run', split: 'tuning', createdAtMs: 3, configurations: [{ label: 'candidate', revisionId: 'unrequested', hash: 'defaults' }] })]
    expect(savedBacktest(jobs, null, 'defaults')?.latest.id).toBe('defaults-run')
    expect(savedBacktest(jobs, null, 'other')).toBeNull()
    expect(savedBacktest(jobs, 'saved', 'defaults')).toBeNull()
  })

  it('summarizes run state, preferring in-flight work', () => {
    expect(runStatus([])).toBeNull()
    expect(runStatus([job({ createdAtMs: 0, updatedAtMs: 38_000 })])).toEqual({ tone: 'ok', kind: 'done', durationMs: 38_000 })
    expect(runStatus([job({}), job({ state: 'running' })])?.kind).toBe('running')
    expect(runStatus([job({}), job({ state: 'queued' })])?.kind).toBe('queued')
    expect(runStatus([job({}), job({ state: 'failed' })])?.tone).toBe('danger')
  })

  it('matches the previous profile by hash, else the runtime baseline', () => {
    expect(baselineLabel(job({}), 'h-default')).toBe('default')
    expect(baselineLabel(job({}), 'unknown')).toBe('current')
    expect(baselineLabel(job({ configurations: [{ label: 'default', revisionId: null, hash: 'a' }] }), null)).toBe('default')
  })

  const window = (metric: 'heart_rate' | 'breathing_rate' | 'window_ibi_variability_v1', mae: number | null, paired: number, cover = 0.9) => ({
    metric, status: mae === null ? 'no_reference' as const : 'compared' as const,
    metrics: mae === null ? null : { mae, medianAbsoluteError: mae, p95AbsoluteError: mae, signedBias: 0 },
    pairedCount: paired, referenceCoverage: 1, outputCoverage: cover, unmatchedReferences: 0, unmatchedObservations: 0, exclusions: {},
  })
  const report: NumericReportView = { nights: [
    { cohortId: '2026-10-11', evaluations: [
      { label: 'current', configHash: 'h-current', windows: [{ startMs: 0, endMs: 1, observationCount: 10, numeric: [window('heart_rate', 3, 10, 0.8), window('breathing_rate', 1, 5)] }] },
      { label: 'candidate', configHash: 'h-saved', windows: [
        { startMs: 0, endMs: 1, observationCount: 10, numeric: [window('heart_rate', 2, 10, 0.9)] },
        { startMs: 1, endMs: 2, observationCount: 30, numeric: [window('heart_rate', 4, 30, 0.5)] },
      ] },
    ] },
    { cohortId: '2026-10-12', evaluations: [
      { label: 'current', configHash: 'h-current', windows: [{ startMs: 0, endMs: 1, observationCount: 10, numeric: [window('heart_rate', null, 0)] }] },
      { label: 'candidate', configHash: 'h-saved', windows: [{ startMs: 0, endMs: 1, observationCount: 10, numeric: [window('heart_rate', null, 0)] }] },
    ] },
  ] }

  it('weights per-night error by paired references and excludes nights without them', () => {
    const nights = nightScores(report, 'holdout', 'current')
    expect(nights[0].saved.heart_rate.mae).toBeCloseTo(3.5)
    expect(nights[0].saved.heart_rate.coverage).toBeCloseTo((0.9 * 10 + 0.5 * 30) / 40)
    expect(nights[0].previous.breathing_rate.mae).toBe(1)
    expect(nights[0].hasReference).toBe(true)
    expect(nights[1].hasReference).toBe(false)
    expect(aggregate(nights, 'heart_rate', 'holdout')).toEqual({ previous: 3, saved: 3.5, nights: 1 })
    expect(aggregate(nights, 'heart_rate', 'tuning').nights).toBe(0)
    expect(coverage(nights).previous).toBeCloseTo(0.85)
  })

  it('colours only real improvements green and any regression amber', () => {
    expect(compareTone(3, 2.9)).toBe('better')
    expect(compareTone(3, 2.97)).toBe('same')
    expect(compareTone(3, 3.01)).toBe('worse')
    expect(compareTone(0.9, 0.95, true)).toBe('better')
    expect(compareTone(0.9, 0.903, true)).toBe('same')
    expect(compareTone(3, 2.9, false, 0.2)).toBe('same')
    expect(compareTone(0.9, 0.8, true)).toBe('worse')
    expect(compareTone(null, 1)).toBe('same')
  })

  it('scales bars 0–5 bpm onto 72 px and clamps', () => {
    expect(barHeight(null)).toBe(0)
    expect(barHeight(2.5)).toBe(36)
    expect(barHeight(9)).toBe(72)
    expect(barHeight(-1)).toBe(0)
  })
})

describe('nights and traces', () => {
  it('labels a night from its calendar date', () => {
    expect(nightLabel('2026-10-11')).toEqual({ weekday: 'Sun', day: '11' })
    expect(nightLabel('cohort-x')).toEqual({ weekday: 'cohort-x', day: '' })
  })

  it('draws gaps instead of bridging missing readings', () => {
    const d = tracePath([{ t: 0, v: 70 }, { t: 60_000, v: 70 }, { t: 120_000, v: null }, { t: 180_000, v: 100 }, { t: 3_600_000, v: 40 }], 0, 3_600_000)
    expect(d.match(/M/g)).toHaveLength(3)
    expect(d.startsWith('M0.0 75.0 L')).toBe(true)
    expect(d).toContain('364.0 150.0')
  })

  it('ticks session start, every two hours, and session end', () => {
    const start = Date.UTC(2026, 9, 12, 6, 15), end = Date.UTC(2026, 9, 12, 14, 0)
    const ticks = traceTicks(start, end)
    expect(ticks[0]).toBe(start)
    expect(ticks[ticks.length - 1]).toBe(end)
    expect(ticks.slice(1, -1).map(t => new Date(t).getUTCHours())).toEqual([8, 10, 12])
  })
})
