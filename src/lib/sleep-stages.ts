/**
 * Sleep stage classification — server-side port of iOS SleepAnalyzer.
 *
 * Classifies vitals + movement data into discrete sleep stages by evaluating
 * a StageRuleset (see sleep-stage-rules.ts). The default ruleset reproduces
 * the rule-based iOS algorithm derived from ballistocardiography patterns.
 *
 * Stages: Wake, Light, Deep, REM
 * Input: 5-minute interval vitals (HR, HRV, breathing rate) + movement
 * Output: Array of SleepEpoch with stage, duration, and associated vitals
 */

import {
  DEFAULT_STAGE_RULESET,
  type StageCondition,
  type StageMetric,
  type StageRuleset,
} from './sleep-stage-rules'

export type SleepStage = 'wake' | 'light' | 'deep' | 'rem'

export interface SleepEpoch {
  start: number // unix ms
  duration: number // ms (typically 300_000 = 5 min)
  stage: SleepStage
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
  movement: number | null
}

export interface SleepStageBlock {
  start: number // unix ms
  end: number // unix ms
  stage: SleepStage
}

export interface StageDistribution {
  wake: number // percentage 0-100
  light: number
  deep: number
  rem: number
}

export interface SleepStagesResult {
  epochs: SleepEpoch[]
  blocks: SleepStageBlock[]
  distribution: StageDistribution
  qualityScore: number // 0-100
  totalSleepMs: number
  sleepRecordId: number | null
  enteredBedAt: number | null // unix ms
  leftBedAt: number | null // unix ms
}

interface VitalsRow {
  timestamp: Date
  heartRate: number | null
  hrv: number | null
  breathingRate: number | null
}

interface MovementRow {
  timestamp: Date
  totalMovement: number
}

/** Stage colors matching iOS: SleepStagesTimelineView.swift */
export const STAGE_COLORS: Record<SleepStage, string> = {
  wake: '#888888',
  light: '#4a90d9',
  deep: '#2563eb',
  rem: '#a080d0',
}

/** Numeric order for hypnogram Y-axis (0 = bottom, 3 = top) */
export const STAGE_ORDER: Record<SleepStage, number> = {
  deep: 0,
  light: 1,
  rem: 2,
  wake: 3,
}

/** Readings dropped by the outlier limits and the HR spike filter. */
interface OutlierReport {
  rows: VitalsRow[]
  /** Heart-rate readings present before filtering. */
  heartRateReadings: number
  /** Heart-rate readings dropped by the spike filter (not the hard limits). */
  spikesDropped: number
}

/**
 * Filter outlier vitals readings before classification.
 *
 * Applies the ruleset's hard limits and a windowed median filter for HR.
 * Nulls out specific fields rather than removing rows (movement data preserved).
 */
function filterOutliers(vitals: VitalsRow[], limits: StageRuleset['outliers']): OutlierReport {
  const inRange = (v: number | null, r: { min: number, max: number }) => v !== null && v >= r.min && v <= r.max
  let heartRateReadings = 0
  let spikesDropped = 0

  const rows = vitals.map((v, i) => {
    if (v.heartRate !== null) heartRateReadings++
    let heartRate = inRange(v.heartRate, limits.heartRate) ? v.heartRate : null
    const hrv = inRange(v.hrv, limits.hrv) ? v.hrv : null
    const breathingRate = inRange(v.breathingRate, limits.breathingRate) ? v.breathingRate : null

    // Windowed median filter for HR (±2 window = 5 samples)
    if (heartRate !== null && limits.heartRateSpikeStdDevs > 0) {
      const windowStart = Math.max(0, i - 2)
      const windowEnd = Math.min(vitals.length - 1, i + 2)
      const windowHRs = vitals
        .slice(windowStart, windowEnd + 1)
        .map(w => w.heartRate)
        .filter((hr): hr is number => inRange(hr, limits.heartRate))

      if (windowHRs.length > 0) {
        const sorted = [...windowHRs].sort((a, b) => a - b)
        const median = sorted[Math.floor(sorted.length / 2)]

        // Standard deviation of the window
        const mean = windowHRs.reduce((s, h) => s + h, 0) / windowHRs.length
        const variance = windowHRs.reduce((s, h) => s + (h - mean) ** 2, 0) / windowHRs.length
        const stdDev = Math.sqrt(variance)

        // Null out HR if it deviates too far from the window median.
        // stdDev=0 (uniform or single-sample window) would trip on any deviation — skip.
        if (stdDev > 0 && Math.abs(heartRate - median) > limits.heartRateSpikeStdDevs * stdDev) {
          heartRate = null
          spikesDropped++
        }
      }
    }

    return { ...v, heartRate, hrv, breathingRate }
  })

  return { rows, heartRateReadings, spikesDropped }
}

export interface MetricRange { min: number, max: number }

/**
 * What one classification run did with its rules, so an editor can show
 * which rules fire, which are shadowed by an earlier rule, and what the
 * signal looked like. Counts are epochs unless noted.
 */
export interface StageRunStats {
  epochs: number
  /** Whether the low-signal rules were used instead of the normal rules. */
  lowSignal: boolean
  /** Per rule of the active list: epochs it decided (first match wins). */
  ruleHits: number[]
  /** Per rule of the active list: epochs it matched on its own, ignoring earlier rules. */
  ruleMatches: number[]
  /** Per rule: index of the earlier rule that most often took its epochs, when it never fires. */
  shadowedBy: (number | null)[]
  /** Epochs no rule matched (the fallback stage). */
  fallbackHits: number
  /** Range of each metric after the outlier limits; null when the night had none. */
  metricRanges: Record<StageMetric, MetricRange | null>
  /** Heart-rate readings present before filtering. */
  heartRateReadings: number
  /** Heart-rate readings dropped by the spike filter. */
  spikesDropped: number
  /** Epochs changed by single-epoch smoothing. */
  smoothed: number
  /** Epochs changed by the transition constraints. */
  transitionFixes: number
}

export interface StageRun {
  epochs: SleepEpoch[]
  stats: StageRunStats
}

const EMPTY_RANGES = (): Record<StageMetric, MetricRange | null> => ({
  hrRatio: null,
  heartRate: null,
  hrv: null,
  breathingRate: null,
  movement: null,
})

function widen(range: MetricRange | null, v: number | null): MetricRange | null {
  if (v === null) return range
  if (!range) return { min: v, max: v }
  return { min: Math.min(range.min, v), max: Math.max(range.max, v) }
}

/**
 * Classify sleep stages from vitals and movement data.
 *
 * Evaluates the ruleset's first-match rules per epoch (HR ratio is the
 * epoch's HR over the night's mean), then post-processes with temporal
 * smoothing and transition constraints. Below the ruleset's low-signal
 * calibration quality, its low-signal rules apply instead.
 */
export function classifySleepStages(
  vitalsData: VitalsRow[],
  movementData: MovementRow[],
  calibrationQuality: number = 0.0,
  ruleset: StageRuleset = DEFAULT_STAGE_RULESET,
): SleepEpoch[] {
  return runStageClassifier(vitalsData, movementData, calibrationQuality, ruleset).epochs
}

/** classifySleepStages plus the per-rule statistics of the run. */
export function runStageClassifier(
  vitalsData: VitalsRow[],
  movementData: MovementRow[],
  calibrationQuality: number = 0.0,
  ruleset: StageRuleset = DEFAULT_STAGE_RULESET,
): StageRun {
  const lowSignal = calibrationQuality < ruleset.lowSignalBelow
  const rules = lowSignal ? ruleset.lowSignalRules : ruleset.rules
  const stats: StageRunStats = {
    epochs: 0,
    lowSignal,
    ruleHits: rules.map(() => 0),
    ruleMatches: rules.map(() => 0),
    shadowedBy: rules.map(() => null),
    fallbackHits: 0,
    metricRanges: EMPTY_RANGES(),
    heartRateReadings: 0,
    spikesDropped: 0,
    smoothed: 0,
    transitionFixes: 0,
  }
  if (vitalsData.length === 0) return { epochs: [], stats }

  // Sort by timestamp ascending
  const filtered = filterOutliers(
    [...vitalsData].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    ),
    ruleset.outliers,
  )
  const sortedVitals = filtered.rows
  stats.heartRateReadings = filtered.heartRateReadings
  stats.spikesDropped = filtered.spikesDropped

  // Build movement lookup (nearest-neighbor by timestamp)
  const movementMap = new Map<number, number>()
  for (const m of movementData) {
    // Round to nearest 5-minute bucket
    const bucket = Math.round(m.timestamp.getTime() / 300_000) * 300_000
    movementMap.set(bucket, m.totalMovement)
  }

  // Calculate average HR for ratio-based classification
  const validHRs = sortedVitals
    .map(v => v.heartRate)
    .filter((hr): hr is number => hr !== null && hr > 0)
  const avgHR = validHRs.length > 0
    ? validHRs.reduce((s, h) => s + h, 0) / validHRs.length
    : 60

  // Which earlier rule took each epoch a later rule also matched.
  const taken: Map<number, number>[] = rules.map(() => new Map())

  // Phase 1: Initial classification
  const epochs: SleepEpoch[] = sortedVitals.map((v, i) => {
    const ts = v.timestamp.getTime()
    const bucket = Math.round(ts / 300_000) * 300_000
    const mov = movementMap.get(bucket) ?? null

    // Duration = gap to next sample, or 5 min for last
    const nextTs = i < sortedVitals.length - 1
      ? sortedVitals[i + 1].timestamp.getTime()
      : ts + 300_000
    const duration = Math.min(nextTs - ts, 600_000) // cap at 10 min

    const metrics: EpochMetrics = {
      hrRatio: v.heartRate !== null && v.heartRate > 0 ? v.heartRate / avgHR : null,
      heartRate: v.heartRate,
      hrv: v.hrv,
      breathingRate: v.breathingRate,
      movement: mov,
    }
    for (const m of Object.keys(metrics) as StageMetric[]) {
      stats.metricRanges[m] = widen(stats.metricRanges[m], metrics[m])
    }

    let winner: number | null = null
    rules.forEach((rule, r) => {
      if (!rule.when.every(c => conditionHolds(c, metrics))) return
      stats.ruleMatches[r]++
      if (winner === null) {
        winner = r
        stats.ruleHits[r]++
      }
      else {
        taken[r].set(winner, (taken[r].get(winner) ?? 0) + 1)
      }
    })
    if (winner === null) stats.fallbackHits++
    const stage = winner === null ? ruleset.fallback : rules[winner].stage

    return {
      start: ts,
      duration,
      stage,
      heartRate: v.heartRate,
      hrv: v.hrv,
      breathingRate: v.breathingRate,
      movement: mov,
    }
  })
  stats.epochs = epochs.length

  stats.shadowedBy = rules.map((_, r) => {
    if (stats.ruleHits[r] > 0 || stats.ruleMatches[r] === 0) return null
    let best: number | null = null
    for (const [by, n] of taken[r]) {
      if (best === null || n > (taken[r].get(best) ?? 0)) best = by
    }
    return best
  })

  // Phase 2: Temporal smoothing — remove isolated single-epoch spikes (A-B-A → A-A-A)
  if (ruleset.smoothIsolatedEpochs) {
    for (let i = 1; i < epochs.length - 1; i++) {
      if (epochs[i - 1].stage === epochs[i + 1].stage && epochs[i].stage !== epochs[i - 1].stage) {
        epochs[i].stage = epochs[i - 1].stage
        stats.smoothed++
      }
    }
  }

  // Phase 3: Transition constraints — enforce physiological rules
  // (by default Wake/REM ↔ Deep must pass through Light)
  for (let i = 1; i < epochs.length; i++) {
    const prev = epochs[i - 1].stage
    const curr = epochs[i].stage
    const t = ruleset.transitions.find(t => t.from === prev && t.to === curr)
    if (t && t.via !== curr) {
      epochs[i].stage = t.via
      stats.transitionFixes++
    }
  }

  return { epochs, stats }
}

/**
 * Combine the stats of several runs of the same ruleset (one per night).
 * Rule lists must be the same length, so all runs must have used the same
 * list; mixed normal and low-signal runs are combined by the caller.
 */
export function mergeRunStats(runs: StageRunStats[]): StageRunStats | null {
  const [first] = runs
  if (!first) return null
  const n = first.ruleHits.length
  const sum = (pick: (s: StageRunStats) => number) => runs.reduce((acc, s) => acc + pick(s), 0)
  const ranges = EMPTY_RANGES()
  for (const m of Object.keys(ranges) as StageMetric[]) {
    for (const s of runs) {
      const r = s.metricRanges[m]
      ranges[m] = r ? widen(widen(ranges[m], r.min), r.max) : ranges[m]
    }
  }
  const ruleHits = Array.from({ length: n }, (_, r) => sum(s => s.ruleHits[r] ?? 0))
  const ruleMatches = Array.from({ length: n }, (_, r) => sum(s => s.ruleMatches[r] ?? 0))
  const shadowedBy = Array.from({ length: n }, (_, r) => {
    if (ruleHits[r] > 0 || ruleMatches[r] === 0) return null
    return runs.find(s => s.shadowedBy[r] !== null)?.shadowedBy[r] ?? null
  })
  return {
    epochs: sum(s => s.epochs),
    lowSignal: first.lowSignal,
    ruleHits,
    ruleMatches,
    shadowedBy,
    fallbackHits: sum(s => s.fallbackHits),
    metricRanges: ranges,
    heartRateReadings: sum(s => s.heartRateReadings),
    spikesDropped: sum(s => s.spikesDropped),
    smoothed: sum(s => s.smoothed),
    transitionFixes: sum(s => s.transitionFixes),
  }
}

/** Per-stage time in ms across epochs. */
export function stageDurations(epochs: SleepEpoch[]): Record<SleepStage, number> {
  const totals: Record<SleepStage, number> = { wake: 0, light: 0, deep: 0, rem: 0 }
  for (const e of epochs) totals[e.stage] += e.duration
  return totals
}

/**
 * Where two classifications of the same night disagree, as time segments.
 * Epochs are matched by start time; an epoch present in only one run counts
 * as changed.
 */
export function changedSegments(a: SleepEpoch[], b: SleepEpoch[]): { segments: { start: number, end: number }[], changed: number, total: number } {
  const byStart = new Map(b.map(e => [e.start, e]))
  const segments: { start: number, end: number }[] = []
  let changed = 0
  for (const e of a) {
    const other = byStart.get(e.start)
    if (other && other.stage === e.stage) continue
    changed++
    const end = e.start + e.duration
    const last = segments[segments.length - 1]
    if (last && last.end >= e.start) last.end = Math.max(last.end, end)
    else segments.push({ start: e.start, end })
  }
  return { segments, changed, total: a.length }
}

/**
 * Calibration quality to classify a side with, from its piezo calibration
 * profile. A side that has never been calibrated has no evidence of a bad
 * signal, so it gets the full HR/HRV rules rather than movement-only mode.
 * Running and failed recalibrations keep the last completed score.
 */
export function piezoCalibrationQuality(profile?: { qualityScore: number | null } | null): number {
  return profile?.qualityScore ?? 1.0
}

type EpochMetrics = Record<StageMetric, number | null>

function conditionHolds(c: StageCondition, m: EpochMetrics): boolean {
  const v = m[c.metric]
  if (v === null) return false
  switch (c.op) {
    case '<': return v < c.value
    case '<=': return v <= c.value
    case '>': return v > c.value
    case '>=': return v >= c.value
  }
}

/** Merge consecutive epochs of the same stage into blocks for visualization. */
export function mergeIntoBlocks(epochs: SleepEpoch[]): SleepStageBlock[] {
  if (epochs.length === 0) return []

  const blocks: SleepStageBlock[] = []
  let currentBlock: SleepStageBlock = {
    start: epochs[0].start,
    end: epochs[0].start + epochs[0].duration,
    stage: epochs[0].stage,
  }

  for (let i = 1; i < epochs.length; i++) {
    if (epochs[i].stage === currentBlock.stage) {
      currentBlock.end = epochs[i].start + epochs[i].duration
    }
    else {
      blocks.push(currentBlock)
      currentBlock = {
        start: epochs[i].start,
        end: epochs[i].start + epochs[i].duration,
        stage: epochs[i].stage,
      }
    }
  }
  blocks.push(currentBlock)

  return blocks
}

/** Epoch counts keyed reference stage → predicted stage. */
export type StageConfusion = Record<SleepStage, Record<SleepStage, number>>

export interface StageAgreement {
  /** Epochs whose midpoint falls inside a reference segment. */
  epochs: number
  /** Fraction of those epochs whose stage matches the reference (0–1). */
  accuracy: number
  /** Cohen's kappa: agreement beyond chance; null when chance agreement is total. */
  kappa: number | null
  /** confusion[reference][predicted]: how many reference epochs of one stage were predicted as each stage. */
  confusion: StageConfusion
  /** Fraction of each reference stage's epochs predicted correctly; null when the reference has none of that stage. */
  recall: Record<SleepStage, number | null>
}

/**
 * Score classified epochs against reference stages (e.g. Apple Watch) by
 * the reference stage at each epoch's midpoint. Null when no epoch is
 * covered by a reference segment.
 */
export function scoreAgainstReference(epochs: SleepEpoch[], reference: SleepStageBlock[]): StageAgreement | null {
  const stages: SleepStage[] = ['wake', 'light', 'deep', 'rem']
  const zero = (): Record<SleepStage, number> => ({ wake: 0, light: 0, deep: 0, rem: 0 })
  const predicted = zero()
  const actual = zero()
  const confusion: StageConfusion = { wake: zero(), light: zero(), deep: zero(), rem: zero() }
  let covered = 0
  let matches = 0

  for (const e of epochs) {
    const mid = e.start + e.duration / 2
    const ref = reference.find(r => mid >= r.start && mid < r.end)
    if (!ref) continue
    covered++
    predicted[e.stage]++
    actual[ref.stage]++
    confusion[ref.stage][e.stage]++
    if (ref.stage === e.stage) matches++
  }

  if (covered === 0) return null
  const accuracy = matches / covered
  const chance = stages.reduce((sum, s) => sum + (predicted[s] / covered) * (actual[s] / covered), 0)
  const recall = Object.fromEntries(
    stages.map(s => [s, actual[s] === 0 ? null : confusion[s][s] / actual[s]]),
  ) as Record<SleepStage, number | null>
  return {
    epochs: covered,
    accuracy,
    kappa: chance === 1 ? null : (accuracy - chance) / (1 - chance),
    confusion,
    recall,
  }
}

/** Calculate percentage distribution of stages. */
export function calculateDistribution(epochs: SleepEpoch[]): StageDistribution {
  if (epochs.length === 0) {
    return { wake: 0, light: 0, deep: 0, rem: 0 }
  }

  const totals = { wake: 0, light: 0, deep: 0, rem: 0 }
  let totalDuration = 0

  for (const e of epochs) {
    totals[e.stage] += e.duration
    totalDuration += e.duration
  }

  if (totalDuration === 0) {
    return { wake: 0, light: 0, deep: 0, rem: 0 }
  }

  return {
    wake: Math.round((totals.wake / totalDuration) * 100),
    light: Math.round((totals.light / totalDuration) * 100),
    deep: Math.round((totals.deep / totalDuration) * 100),
    rem: Math.round((totals.rem / totalDuration) * 100),
  }
}

/**
 * Calculate sleep quality score (0-100).
 * Based on "Why We Sleep" (Walker, 2017) stage distribution targets.
 */
export function calculateQualityScore(
  distribution: StageDistribution,
  calibrationQuality: number = 1.0,
): number {
  let score = 100

  // Deep sleep: target 15-25%
  if (distribution.deep < 15) {
    score -= (15 - distribution.deep) * 2
  }
  else if (distribution.deep > 30) {
    score -= (distribution.deep - 30) * 1.5
  }

  // REM: target 20-30%
  if (distribution.rem < 20) {
    score -= (20 - distribution.rem) * 1.5
  }
  else if (distribution.rem > 35) {
    score -= (distribution.rem - 35) * 1
  }

  // Wake: target <5%
  if (distribution.wake > 5) {
    score -= (distribution.wake - 5) * 2
  }

  score = Math.max(0, Math.min(100, Math.round(score)))

  // Cap at 50 if calibration quality is low
  if (calibrationQuality < 0.3) {
    score = Math.min(score, 50)
  }

  return score
}

/** Format milliseconds to "Xh Ym" */
export function formatDurationHM(ms: number): string {
  const totalMinutes = Math.round(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}m`
  if (minutes === 0) return `${hours}h`
  return `${hours}h ${minutes}m`
}

/** Rule statistics for one rule list, summed over the nights that used it. */
export interface RuleListStats {
  /** Epochs classified by this list. */
  epochs: number
  hits: number[]
  matches: number[]
  shadowedBy: (number | null)[]
  fallbackHits: number
}

/** Run statistics summed over several nights of one ruleset. */
export interface StageRunSummary {
  epochs: number
  nights: number
  /** Nights whose calibration quality put them on the low-signal rules. */
  lowSignalNights: number
  /** Normal rules, over the nights that used them; null when none did. */
  rules: RuleListStats | null
  /** Low-signal rules, over the nights that used them; null when none did. */
  lowSignalRules: RuleListStats | null
  metricRanges: Record<StageMetric, MetricRange | null>
  heartRateReadings: number
  spikesDropped: number
  smoothed: number
  transitionFixes: number
}

const listStats = (s: StageRunStats | null): RuleListStats | null => s && ({
  epochs: s.epochs,
  hits: s.ruleHits,
  matches: s.ruleMatches,
  shadowedBy: s.shadowedBy,
  fallbackHits: s.fallbackHits,
})

/** Combine per-night run stats, keeping normal and low-signal rule stats apart. */
export function summarizeRuns(runs: StageRunStats[]): StageRunSummary {
  const all = mergeRunStats(runs)
  const normal = mergeRunStats(runs.filter(r => !r.lowSignal))
  const low = mergeRunStats(runs.filter(r => r.lowSignal))
  return {
    epochs: all?.epochs ?? 0,
    nights: runs.length,
    lowSignalNights: runs.filter(r => r.lowSignal).length,
    rules: listStats(normal),
    lowSignalRules: listStats(low),
    metricRanges: all?.metricRanges ?? EMPTY_RANGES(),
    heartRateReadings: all?.heartRateReadings ?? 0,
    spikesDropped: all?.spikesDropped ?? 0,
    smoothed: all?.smoothed ?? 0,
    transitionFixes: all?.transitionFixes ?? 0,
  }
}

/** Inputs of one night for classifyNights. */
export interface NightInputs {
  vitalsData: VitalsRow[]
  movementData: MovementRow[]
  calibrationQuality: number
  /** Reference stages (e.g. Apple Watch) overlapping the night. */
  reference: SleepStageBlock[]
}

export interface NightsSummary {
  /** Stage blocks of the first (latest) night. */
  blocks: SleepStageBlock[]
  /** Percent of epochs per stage, over every night. */
  distribution: StageDistribution
  /** Mean quality score over the nights. */
  qualityScore: number
  /** Mean time in bed per night, ms. */
  totalSleepMs: number
  /** Mean time per stage per night, ms. */
  durations: Record<SleepStage, number>
  agreement: StageAgreement | null
  stats: StageRunSummary
}

/**
 * Classify several nights (latest first) with one ruleset and aggregate the
 * result for a preview. Null when no night has vitals.
 */
export function classifyNights(
  nights: NightInputs[],
  ruleset: StageRuleset,
): { summary: NightsSummary, latestEpochs: SleepEpoch[] } | null {
  const allRuns = nights.map(n => ({ ...runStageClassifier(n.vitalsData, n.movementData, n.calibrationQuality, ruleset), night: n }))
  // Aggregates skip nights without vitals, but the latest night stays the
  // latest night: a preview must not describe an older night as "last night".
  const runs = allRuns.filter(r => r.epochs.length > 0)
  if (runs.length === 0) return null
  const latest = allRuns[0]

  const allEpochs = runs.flatMap(r => r.epochs)
  const allReference = runs.flatMap(r => r.night.reference)
  const quality = runs.reduce((sum, r) => sum + calculateQualityScore(calculateDistribution(r.epochs), r.night.calibrationQuality), 0) / runs.length
  const totals = stageDurations(allEpochs)
  const perNight = (ms: number) => Math.round(ms / runs.length)

  return {
    latestEpochs: latest.epochs,
    summary: {
      blocks: mergeIntoBlocks(latest.epochs),
      distribution: calculateDistribution(allEpochs),
      qualityScore: Math.round(quality),
      totalSleepMs: perNight(allEpochs.reduce((sum, e) => sum + e.duration, 0)),
      durations: { wake: perNight(totals.wake), light: perNight(totals.light), deep: perNight(totals.deep), rem: perNight(totals.rem) },
      agreement: scoreAgainstReference(allEpochs, allReference),
      stats: summarizeRuns(runs.map(r => r.stats)),
    },
  }
}
