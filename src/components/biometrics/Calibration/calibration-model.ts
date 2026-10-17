import type { BiometricConfig } from '@/src/biometrics/algorithms/registry'
import type { StageClassifier, StageMetric, StageOperator } from '@/src/lib/sleep-stage-rules'
import type { NumericReportView } from './report-view'

/**
 * View model for the single-page calibration screen: one saved profile, one
 * previous, the processor's acknowledgement, and the backtest that compared
 * them. Pure functions only; the page component owns queries and wording.
 */

export type ParamPath
  = | 'heart_rate.trackingToleranceBpm'
    | 'heart_rate.trackingHistoryLength'
    | 'heart_rate.minimumPeakScore'
    | 'breathing_rate.intervalLowerRatio'
    | 'breathing_rate.intervalUpperRatio'
    | 'hrv_index.minimumWindows'

export interface ParamSpec { path: ParamPath, key: string, min: number, max: number, step: number, decimals: number }

/** Bounds mirror modules/common/biometrics/manifest.v1.json. */
export const PARAMS: Record<ParamPath, ParamSpec> = {
  'heart_rate.trackingToleranceBpm': { path: 'heart_rate.trackingToleranceBpm', key: 'trackingToleranceBpm', min: 5, max: 30, step: 1, decimals: 0 },
  'heart_rate.trackingHistoryLength': { path: 'heart_rate.trackingHistoryLength', key: 'trackingHistoryLength', min: 1, max: 10, step: 1, decimals: 0 },
  'heart_rate.minimumPeakScore': { path: 'heart_rate.minimumPeakScore', key: 'minimumPeakScore', min: 0.1, max: 0.8, step: 0.05, decimals: 2 },
  'breathing_rate.intervalLowerRatio': { path: 'breathing_rate.intervalLowerRatio', key: 'intervalLowerRatio', min: 0.25, max: 0.9, step: 0.05, decimals: 2 },
  'breathing_rate.intervalUpperRatio': { path: 'breathing_rate.intervalUpperRatio', key: 'intervalUpperRatio', min: 1.1, max: 2, step: 0.05, decimals: 2 },
  'hrv_index.minimumWindows': { path: 'hrv_index.minimumWindows', key: 'minimumWindows', min: 10, max: 30, step: 1, decimals: 0 },
}
export const PARAM_PATHS = Object.keys(PARAMS) as ParamPath[]

export type Draft = Record<ParamPath, number>

export function readParam(config: BiometricConfig, path: ParamPath): number {
  const [group, key] = path.split('.') as [keyof BiometricConfig, string]
  return (config[group] as unknown as Record<string, number>)[key]
}

export function draftFrom(config: BiometricConfig): Draft {
  return Object.fromEntries(PARAM_PATHS.map(path => [path, readParam(config, path)])) as Draft
}

/** Trim float noise from slider steps (0.1 + 0.05 → 0.15000000000000002). */
export function roundParam(path: ParamPath, value: number): number {
  const factor = 10 ** PARAMS[path].decimals
  return Math.round(value * factor) / factor
}

export function changedPaths(draft: Draft, saved: BiometricConfig): ParamPath[] {
  return PARAM_PATHS.filter(path => draft[path] !== readParam(saved, path))
}

/**
 * The saved overrides with the edited numeric paths replaced. A value equal to
 * the shipped default drops its override so it inherits again.
 */
export function overridesFor(saved: Array<{ path: string, value: unknown }>, draft: Draft, defaults: BiometricConfig) {
  const edited = new Set<string>(PARAM_PATHS)
  const kept = saved.filter(row => !edited.has(row.path))
  const numeric = PARAM_PATHS
    .filter(path => draft[path] !== readParam(defaults, path))
    .map(path => ({ path, value: draft[path] }))
  return [...kept, ...numeric]
}

/* ─── Actors ───────────────────────────────────────────────────────────── */

export type ActorKind = 'agent' | 'you' | 'pod'
export interface Actor { kind: ActorKind, name: string }

/** Requesters the web app writes as; anything else came over MCP or the API. */
const WEB_REQUESTERS = new Set(['web-calibration', 'legacy-stage-settings', 'web'])

export function actorOf(requester: string, origin?: 'manual' | 'migration' | 'agent' | 'system'): Actor {
  if (origin === 'migration' || origin === 'system' || requester === 'system' || requester === 'migration') return { kind: 'pod', name: 'pod' }
  if (origin === 'manual' || WEB_REQUESTERS.has(requester)) return { kind: 'you', name: 'you' }
  return { kind: 'agent', name: requester }
}

/* ─── Time ─────────────────────────────────────────────────────────────── */

/** "38 s", "14 min", "3 h", "2 d" */
export function shortDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 48) return `${h} h`
  return `${Math.round(h / 24)} d`
}

export function relativeTime(atMs: number, nowMs: number): string {
  const ms = nowMs - atMs
  return ms < 45_000 ? 'just now' : `${shortDuration(ms)} ago`
}

/* ─── Lifecycle strip ──────────────────────────────────────────────────── */

export type DotTone = 'ok' | 'warn' | 'danger' | 'muted'
export interface Segment { tone: DotTone, value: string }

type ObservedState = 'unreported' | 'pending_delivery' | 'pending_boundary' | 'applied' | 'failed'

export interface LifecycleInput {
  nowMs: number
  /** Desired revision; null when the saved profile is system defaults. */
  saved: { actor: Actor, atMs: number } | null
  bindingUpdatedAtMs: number
  generation: number
  /** Activation for the current generation. */
  request: { observedState: ObservedState, createdAtMs: number, updatedAtMs: number, previousIsDefaults: boolean } | null
  runtimeReported: boolean
}

export function lifecycle(input: LifecycleInput): { saved: Segment, requested: Segment, processor: Segment } {
  const { nowMs, request } = input
  const saved: Segment = input.saved
    ? { tone: 'ok', value: `by ${input.saved.actor.name} · ${relativeTime(input.saved.atMs, nowMs)}` }
    : input.generation > 0
      ? { tone: 'ok', value: `system defaults · ${relativeTime(input.bindingUpdatedAtMs, nowMs)}` }
      : { tone: 'ok', value: 'system defaults' }

  let requested: Segment
  let processor: Segment
  if (!request || request.observedState === 'unreported') {
    requested = { tone: 'muted', value: 'none' }
    processor = input.runtimeReported
      ? { tone: 'ok', value: input.saved ? 'running saved' : 'running system defaults' }
      : { tone: 'muted', value: 'not reported' }
  }
  else if (request.observedState === 'applied') {
    requested = { tone: 'ok', value: `acknowledged ${relativeTime(request.updatedAtMs, nowMs)}` }
    processor = { tone: 'ok', value: 'running saved' }
  }
  else {
    const failed = request.observedState === 'failed'
    requested = failed
      ? { tone: 'danger', value: 'failed' }
      : { tone: 'warn', value: `waiting ${shortDuration(nowMs - request.createdAtMs)}` }
    processor = { tone: failed ? 'danger' : 'ok', value: request.previousIsDefaults ? 'running system defaults' : 'running previous' }
  }
  return { saved, requested, processor }
}

/* ─── Sleep-stage overrides ────────────────────────────────────────────── */

export interface StageOverride { rule: number, stage: string, metric: StageMetric, op: StageOperator, before: number, after: number }

/**
 * Condition values that differ from the shipped rules, rule by rule. When the
 * rule list itself was reshaped, values can't be paired; that is reported as
 * `restructured` instead.
 */
export function stageOverrides(defaults: StageClassifier, saved: StageClassifier) {
  if (defaults.engine !== 'rules' || saved.engine !== 'rules') return { ruleCount: 0, overrides: [] as StageOverride[], restructured: defaults.engine !== saved.engine, fallbackChanged: false }
  const a = defaults.ruleset, b = saved.ruleset
  const overrides: StageOverride[] = []
  let restructured = a.rules.length !== b.rules.length
  if (!restructured) {
    b.rules.forEach((rule, i) => {
      const base = a.rules[i]
      if (base.stage !== rule.stage || base.when.length !== rule.when.length) {
        restructured = true
        return
      }
      rule.when.forEach((condition, j) => {
        const was = base.when[j]
        if (was.metric !== condition.metric || was.op !== condition.op) restructured = true
        else if (was.value !== condition.value) overrides.push({ rule: i + 1, stage: rule.stage, metric: condition.metric, op: condition.op, before: was.value, after: condition.value })
      })
    })
  }
  return { ruleCount: b.rules.length, overrides, restructured, fallbackChanged: a.fallback !== b.fallback }
}

/* ─── Backtests ────────────────────────────────────────────────────────── */

export type Split = 'tuning' | 'validation' | 'holdout'
export type ConfigLabel = 'default' | 'current' | 'candidate'
export interface JobLike {
  id: string
  experimentId: string
  datasetId: string
  split: Split
  state: 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'succeeded' | 'failed' | 'interrupted'
  createdAtMs: number
  updatedAtMs: number
  configurations: Array<{ label: string, revisionId: string | null, hash: string }>
  evaluationScope: 'original_readings_comparison' | 'stage_rules_on_original_readings' | 'retained_waveform_replay'
}

/**
 * The latest run of the saved profile, as one job per split on the dataset
 * that run used. With no saved revision (system defaults), a run of any
 * candidate that resolves to the saved configuration stands in for it.
 */
export function savedBacktest<J extends JobLike>(jobs: J[], savedRevisionId: string | null, savedHash?: string | null) {
  const isSaved = (c: JobLike['configurations'][number]) => c.label === 'candidate'
    && (savedRevisionId ? c.revisionId === savedRevisionId : Boolean(savedHash) && c.hash === savedHash)
  const mine = jobs
    .filter(job => job.configurations.some(isSaved))
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
  if (!mine.length) return null
  const datasetId = mine[0].datasetId
  const bySplit: Partial<Record<Split, J>> = {}
  for (const job of mine) {
    if (job.datasetId !== datasetId || job.state === 'cancelled') continue
    const prior = bySplit[job.split]
    // Prefer the newest finished run of a split over a newer failed retry.
    if (!prior || (prior.state !== 'succeeded' && job.state === 'succeeded')) bySplit[job.split] = job
  }
  const jobsInGroup = Object.values(bySplit) as J[]
  return { datasetId, experimentId: mine[0].experimentId, bySplit, latest: mine[0], jobs: jobsInGroup }
}

export interface RunStatus { tone: DotTone, kind: 'done' | 'running' | 'queued' | 'failed', durationMs: number }

export function runStatus(jobs: JobLike[]): RunStatus | null {
  if (!jobs.length) return null
  if (jobs.some(job => job.state === 'running' || job.state === 'cancel_requested')) return { tone: 'warn', kind: 'running', durationMs: 0 }
  if (jobs.some(job => job.state === 'queued')) return { tone: 'warn', kind: 'queued', durationMs: 0 }
  if (jobs.some(job => job.state === 'failed' || job.state === 'interrupted')) return { tone: 'danger', kind: 'failed', durationMs: 0 }
  const start = Math.min(...jobs.map(job => job.createdAtMs)), end = Math.max(...jobs.map(job => job.updatedAtMs))
  return { tone: 'ok', kind: 'done', durationMs: end - start }
}

/** Previous = the pinned configuration matching the previous profile, else the runtime baseline. */
export function baselineLabel(job: JobLike, previousHash: string | null): ConfigLabel {
  const byHash = previousHash ? job.configurations.find(c => c.hash === previousHash && c.label !== 'candidate') : undefined
  if (byHash) return byHash.label as ConfigLabel
  return job.configurations.some(c => c.label === 'current') ? 'current' : 'default'
}

type Metric = 'heart_rate' | 'breathing_rate' | 'window_ibi_variability_v1'
export interface MetricScore { mae: number | null, paired: number, coverage: number | null }
export interface NightScore {
  cohortId: string
  split: Split
  previous: Record<Metric, MetricScore>
  saved: Record<Metric, MetricScore>
  /** Saved configuration was paired with at least one heart-rate reference. */
  hasReference: boolean
}

function score(evaluation: NumericReportView['nights'][number]['evaluations'][number] | undefined, metric: Metric): MetricScore {
  let paired = 0, weighted = 0, coverage = 0, observations = 0
  for (const window of evaluation?.windows ?? []) {
    const row = window.numeric.find(n => n.metric === metric)
    if (!row) continue
    if (row.status === 'compared' && row.metrics?.mae != null && row.pairedCount > 0) {
      paired += row.pairedCount
      weighted += row.metrics.mae * row.pairedCount
    }
    if (row.outputCoverage != null && window.observationCount > 0) {
      coverage += row.outputCoverage * window.observationCount
      observations += window.observationCount
    }
  }
  return { mae: paired ? weighted / paired : null, paired, coverage: observations ? coverage / observations : null }
}

const METRICS: Metric[] = ['heart_rate', 'breathing_rate', 'window_ibi_variability_v1']

/** Per-night agreement of previous and saved from one split's report. */
export function nightScores(report: NumericReportView, split: Split, previous: ConfigLabel): NightScore[] {
  return report.nights.map((night) => {
    const prev = night.evaluations.find(e => e.label === previous)
    const saved = night.evaluations.find(e => e.label === 'candidate')
    const p = Object.fromEntries(METRICS.map(m => [m, score(prev, m)])) as Record<Metric, MetricScore>
    const s = Object.fromEntries(METRICS.map(m => [m, score(saved, m)])) as Record<Metric, MetricScore>
    return { cohortId: night.cohortId, split, previous: p, saved: s, hasReference: s.heart_rate.paired > 0 }
  })
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null

/** Equal-night mean error; nights without a reference are excluded. */
export function aggregate(nights: NightScore[], metric: Metric, split?: Split) {
  const rows = nights.filter(n => (!split || n.split === split) && n.previous[metric].mae !== null && n.saved[metric].mae !== null)
  return {
    previous: mean(rows.map(n => n.previous[metric].mae as number)),
    saved: mean(rows.map(n => n.saved[metric].mae as number)),
    nights: rows.length,
  }
}

export function coverage(nights: NightScore[]) {
  const pick = (side: 'previous' | 'saved') => mean(nights.flatMap(n => n[side].heart_rate.coverage === null ? [] : [n[side].heart_rate.coverage as number]))
  return { previous: pick('previous'), saved: pick('saved') }
}

/**
 * Lower is better for errors; the colour only marks a real difference. The
 * threshold is in the metric's own unit: 0.05 for errors (bpm, ms, br/min),
 * 0.005 (half a point) for fractions such as coverage.
 */
export function compareTone(previous: number | null, saved: number | null, higherIsBetter = false, threshold = higherIsBetter ? 0.005 : 0.05): 'better' | 'worse' | 'same' {
  if (previous === null || saved === null) return 'same'
  const delta = higherIsBetter ? previous - saved : saved - previous
  if (delta < -threshold) return 'better'
  if (delta > 0) return 'worse'
  return 'same'
}

/** 0–5 bpm → 0–72 px. */
export function barHeight(mae: number | null, px = 72, top = 5): number {
  if (mae === null) return 0
  return Math.round(Math.max(0, Math.min(1, mae / top)) * px)
}

/* ─── Nights ───────────────────────────────────────────────────────────── */

/** "2026-10-11" → { weekday: 'Sun', day: 11 }, read as a calendar date. */
export function nightLabel(cohortId: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(cohortId)
  if (!m) return { weekday: cohortId, day: '' }
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()], day: String(date.getUTCDate()) }
}

/** Reference sources whose time span overlaps the night, e.g. "watch + ring". */
export function nightSources(night: { startMs: number, endMs: number }, imports: Array<{ source: string, startMs: number | null, endMs: number | null }>) {
  const sources = imports
    .filter(i => i.startMs !== null && i.endMs !== null && i.startMs < night.endMs && i.endMs > night.startMs)
    .map(i => i.source)
  return [...new Set(sources)].join(' + ')
}

/* ─── Trace ────────────────────────────────────────────────────────────── */

export const TRACE = { width: 364, height: 150, minBpm: 40, maxBpm: 100 }

/** SVG path for timestamped values; gaps over `gapMs` break the line. */
export function tracePath(points: Array<{ t: number, v: number | null }>, startMs: number, endMs: number, gapMs = 10 * 60_000) {
  const span = Math.max(1, endMs - startMs)
  let d = '', last: number | null = null
  for (const p of points) {
    if (p.v === null || p.t < startMs || p.t > endMs) {
      last = null
      continue
    }
    const x = ((p.t - startMs) / span) * TRACE.width
    const clamped = Math.max(TRACE.minBpm, Math.min(TRACE.maxBpm, p.v))
    const y = TRACE.height - ((clamped - TRACE.minBpm) / (TRACE.maxBpm - TRACE.minBpm)) * TRACE.height
    d += `${last === null || p.t - last > gapMs ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)} `
    last = p.t
  }
  return d.trim()
}

/** Session start, every two hours on the hour, session end. */
export function traceTicks(startMs: number, endMs: number) {
  const ticks = [startMs]
  const hour = 3_600_000
  let t = Math.ceil(startMs / (2 * hour)) * 2 * hour
  for (; t < endMs; t += 2 * hour) {
    if (t - startMs > 40 * 60_000 && endMs - t > 40 * 60_000) ticks.push(t)
  }
  ticks.push(endMs)
  return ticks
}

/* ─── Diffs ────────────────────────────────────────────────────────────── */

/** "trackingToleranceBpm 15 → 12" for each numeric parameter that moved. */
export function paramDiffs(before: BiometricConfig, after: BiometricConfig) {
  return PARAM_PATHS
    .filter(path => readParam(before, path) !== readParam(after, path))
    .map(path => `${PARAMS[path].key} ${readParam(before, path)} → ${readParam(after, path)}`)
}

/* ─── Clock labels ─────────────────────────────────────────────────────── */

function zoned(ms: number, timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23', month: 'short', day: 'numeric' }).formatToParts(ms)
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
    return { hour: Number(get('hour')), minute: Number(get('minute')), month: get('month'), day: get('day') }
  }
  catch {
    return zoned(ms, 'UTC')
  }
}

/** Axis label: "11:15p", "1a" (12h) or "23:15", "01:00" (24h). */
export function clockLabel(ms: number, timeZone: string, h24: boolean) {
  const { hour, minute } = zoned(ms, timeZone)
  const mm = String(minute).padStart(2, '0')
  if (h24) return `${String(hour).padStart(2, '0')}:${mm}`
  const h = hour % 12 || 12
  return `${h}${minute ? `:${mm}` : ''}${hour < 12 ? 'a' : 'p'}`
}

/** Relative under a day, else "Oct 9 · 11:43 PM". */
export function activityTime(ms: number, nowMs: number, timeZone: string, h24: boolean) {
  if (nowMs - ms < 86_400_000) return relativeTime(ms, nowMs)
  const { hour, minute, month, day } = zoned(ms, timeZone)
  const mm = String(minute).padStart(2, '0')
  const clock = h24 ? `${String(hour).padStart(2, '0')}:${mm}` : `${hour % 12 || 12}:${mm} ${hour < 12 ? 'AM' : 'PM'}`
  return `${month} ${day} · ${clock}`
}
