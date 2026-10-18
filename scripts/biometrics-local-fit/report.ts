import { z } from 'zod'
import type { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { defaultConfig, type Override } from '@/src/biometrics/algorithms/registry'
import type { createNumericNightSummary } from '@/src/biometrics/backtest/numeric-night-summary'

export const METRICS = ['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const
type Metric = typeof METRICS[number]
type EvaluatorReport = ReturnType<typeof evaluateBacktest>
type NightSummary = ReturnType<ReturnType<typeof createNumericNightSummary>>[number]

const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

interface OwnScore { pairedCount: number, metrics: { mae: number } | null }
interface NumericWindow { metrics: Array<{ metric: string, baseline: string, candidate: string, ownSupport: { baseline: OwnScore, candidate: OwnScore } }> }

/** Pool each configuration's own-support error across a night's windows. Unlike
 * common support, this credits a candidate that abstains on hard windows, so it
 * is always reported with the Watch coverage it kept. */
function ownSupportNights(report: EvaluatorReport, metric: Metric) {
  return (report.nights as Array<{ cohortId: string, numericComparisons?: NumericWindow[] }>).map((night) => {
    const pooled = { default: { paired: 0, error: 0 }, candidate: { paired: 0, error: 0 } }
    for (const window of night.numericComparisons ?? []) {
      const row = window.metrics.find(item => item.metric === metric && item.baseline === 'default' && item.candidate === 'candidate')
      if (!row) continue
      for (const [key, score] of [['default', row.ownSupport.baseline], ['candidate', row.ownSupport.candidate]] as const) {
        if (score.metrics && score.pairedCount) {
          pooled[key].paired += score.pairedCount
          pooled[key].error += score.metrics.mae * score.pairedCount
        }
      }
    }
    const mae = (key: 'default' | 'candidate') => pooled[key].paired ? pooled[key].error / pooled[key].paired : null
    return { cohortId: night.cohortId, defaultPairedCount: pooled.default.paired, candidatePairedCount: pooled.candidate.paired,
      defaultMae: mae('default'), candidateMae: mae('candidate') }
  })
}

function metricSummary(report: EvaluatorReport, metric: Metric) {
  const summary = (report.numericNightSummary as NightSummary[] | undefined)
    ?.find(row => row.metric === metric && row.baseline === 'default' && row.candidate === 'candidate')
  const nights = (summary?.nights ?? []).map(night => ({ cohortId: night.cohortId, pairedCount: night.commonSupport.candidate.pairedCount,
    defaultMae: night.commonSupport.baseline.mae, candidateMae: night.commonSupport.candidate.mae, maeDifference: night.commonMaeDifference,
    coverageReduced: night.coverageReduced, lostObservationTimestamps: night.lostObservationTimestamps }))
  const scored = nights.filter(night => night.maeDifference !== null)
  const own = ownSupportNights(report, metric)
  const ownScored = own.filter(night => night.defaultMae !== null && night.candidateMae !== null)
  const defaultPairs = own.reduce((sum, night) => sum + night.defaultPairedCount, 0)
  return { status: scored.length ? 'scored' as const : 'no_paired_reference' as const,
    totalNights: nights.length, scoredNights: scored.length, coverageReducedNights: nights.filter(night => night.coverageReduced).length,
    equalNightMeanMae: { default: mean(scored.map(night => night.defaultMae as number)), candidate: mean(scored.map(night => night.candidateMae as number)) },
    equalNightMeanMaeDifference: summary?.equalNightMeanMaeDifference ?? null, nights,
    ownSupport: { equalNightMeanMae: { default: mean(ownScored.map(night => night.defaultMae as number)), candidate: mean(ownScored.map(night => night.candidateMae as number)) },
      referenceCoverage: defaultPairs ? own.reduce((sum, night) => sum + night.candidatePairedCount, 0) / defaultPairs : null, nights: own } }
}
export type MetricSummary = ReturnType<typeof metricSummary>

/** One report per candidate per split. Everything here was computed off-pod
 * and is labelled so it cannot be mistaken for the pod's backtest evidence. */
export function summarizeLocalReport(input: {
  candidate: { id: string, overrides: Array<{ path: string, value: unknown }>, resolvedHash: string }
  split: 'tuning' | 'validation' | 'holdout'
  report: EvaluatorReport
  dataset: { id: string, contentHash: string }
  build: { pythonBuildHash: string, pythonSourcesHash: string, evaluatorBuildHash: string }
  protocol: unknown
}) {
  return { version: 'biometrics-local-fit-report-v1' as const, label: 'exploratory-local' as const,
    evidence: 'not_activation_evidence' as const,
    notice: 'Computed off-pod from an exported dataset bundle. Only a backtest run on the pod can support activation; create the candidate with propose_biometric_profile and backtest it there.',
    candidate: { id: input.candidate.id, overrides: input.candidate.overrides as Override[], resolvedHash: input.candidate.resolvedHash },
    split: input.split, dataset: { id: input.dataset.id, contentHash: input.dataset.contentHash }, build: input.build, protocol: input.protocol,
    summary: Object.fromEntries(METRICS.map(metric => [metric, metricSummary(input.report, metric)])) as Record<Metric, MetricSummary>,
    report: input.report }
}
export type LocalFitReport = ReturnType<typeof summarizeLocalReport>

const reportShape = z.object({ version: z.literal('biometrics-local-fit-report-v1'), label: z.literal('exploratory-local'),
  evidence: z.literal('not_activation_evidence'), candidate: z.object({ id: z.string(), resolvedHash: z.string() }).passthrough(),
  split: z.enum(['tuning', 'validation', 'holdout']), summary: z.record(z.string(), z.object({ status: z.string(), nights: z.array(z.unknown()) }).passthrough()) }).passthrough()
export function parseLocalReport(value: unknown) {
  return reportShape.parse(value) as unknown as LocalFitReport
}

/** Rank by the tuning split's equal-night mean HR error difference against
 * defaults on common support (lower is better), validation shown alongside. */
export function rankCandidates(reports: LocalFitReport[], minimumCoverage = 0.75) {
  if (!Number.isFinite(minimumCoverage) || minimumCoverage < 0 || minimumCoverage > 1) throw new Error('Minimum coverage must be a fraction from 0 to 1')
  const ids = [...new Set(reports.map(report => report.candidate.id))]
  const pick = (id: string, split: 'tuning' | 'validation' | 'holdout') => reports.find(report => report.candidate.id === id && report.split === split)
  const view = (report: LocalFitReport | undefined, metric: Metric) => report
    ? { maeDifference: report.summary[metric].equalNightMeanMaeDifference, mae: report.summary[metric].equalNightMeanMae.candidate,
        ownMae: report.summary[metric].ownSupport?.equalNightMeanMae.candidate ?? null, coverage: report.summary[metric].ownSupport?.referenceCoverage ?? null,
        scoredNights: report.summary[metric].scoredNights, coverageReducedNights: report.summary[metric].coverageReducedNights }
    : null
  const key = (value: number | null | undefined) => value ?? Number.POSITIVE_INFINITY
  // Ties go to the candidate that changes the fewest defaults.
  const changes = (overrides: Override[]) => overrides.filter(row => row.path.split('.')
    .reduce<unknown>((parent, part) => (parent as Record<string, unknown> | undefined)?.[part], defaultConfig) !== row.value).length
  const rows = ids.map((id) => {
    const tuning = pick(id, 'tuning'), validation = pick(id, 'validation'), holdout = pick(id, 'holdout')
    const candidate = (tuning ?? validation ?? holdout)?.candidate
    return { id, overrides: candidate?.overrides ?? [], resolvedHash: candidate?.resolvedHash ?? '', changedDefaults: changes(candidate?.overrides ?? []),
      heartRate: { tuning: view(tuning, 'heart_rate'), validation: view(validation, 'heart_rate'), ...(holdout ? { holdout: view(holdout, 'heart_rate') } : {}) },
      breathingRate: { tuning: view(tuning, 'breathing_rate'), validation: view(validation, 'breathing_rate') },
      hrv: { tuning: view(tuning, 'window_ibi_variability_v1'), validation: view(validation, 'window_ibi_variability_v1') } }
  })
  // A candidate below the coverage floor ranks after every one above it, so
  // abstaining on most of the night cannot win on error alone.
  const kept = (row: typeof rows[number]) => (row.heartRate.tuning?.coverage ?? 1) >= minimumCoverage ? 0 : 1
  rows.sort((a, b) => kept(a) - kept(b)
    || key(a.heartRate.tuning?.ownMae) - key(b.heartRate.tuning?.ownMae)
    || key(a.heartRate.validation?.ownMae) - key(b.heartRate.validation?.ownMae)
    || (a.heartRate.tuning?.coverageReducedNights ?? 0) - (b.heartRate.tuning?.coverageReducedNights ?? 0)
    || a.changedDefaults - b.changedDefaults
    || a.id.localeCompare(b.id))
  return { version: 'biometrics-local-fit-ranking-v1' as const, label: 'exploratory-local' as const, evidence: 'not_activation_evidence' as const,
    rankedBy: 'tuning.heart_rate.ownSupport_equalNightMeanMae_with_reference_coverage_floor' as const, minimumCoverage,
    rows: rows.map((row, index) => ({ rank: index + 1, ...row })) }
}

const format = (value: number | null | undefined, digits = 3) => value === null || value === undefined ? 'n/a' : value.toFixed(digits)
const percent = (value: number | null | undefined) => value === null || value === undefined ? 'n/a' : `${Math.round(value * 100)}%`
export function rankingMarkdown(ranking: ReturnType<typeof rankCandidates>) {
  const holdout = ranking.rows.some(row => row.heartRate.holdout)
  const splits = ['tuning', 'validation', ...(holdout ? ['holdout'] : [])] as const
  const lines = [`_Exploratory, computed off-pod. Not activation evidence. Ranked by tuning HR error on each candidate's own readings, among candidates keeping ≥${percent(ranking.minimumCoverage)} of the defaults' Watch coverage._`, '',
    `| # | candidate | ${splits.map(split => `${split} HR MAE | ${split} Δ common | ${split} coverage`).join(' | ')} | BR Δ (t) | HRV Δ (t) |`,
    `| ---: | --- | ${splits.map(() => '---: | ---: | ---:').join(' | ')} | ---: | ---: |`]
  for (const row of ranking.rows) {
    const cells = splits.map((split) => {
      const view = row.heartRate[split as 'tuning']
      return `${format(view?.ownMae)} | ${format(view?.maeDifference)} | ${percent(view?.coverage)}`
    })
    lines.push(`| ${row.rank} | ${row.id} | ${cells.join(' | ')} | ${format(row.breathingRate.tuning?.maeDifference)} | ${format(row.hrv.tuning?.maeDifference)} |`)
  }
  return `${lines.join('\n')}\n`
}

const podResultSchema = z.object({ report: z.object({ split: z.enum(['tuning', 'validation', 'holdout']), datasetHash: z.string(),
  numericNightSummary: z.array(z.object({ metric: z.string(), baseline: z.string(), candidate: z.string(), baselineHash: z.string(), candidateHash: z.string(),
    nights: z.array(z.object({ cohortId: z.string(), commonSupport: z.object({ baseline: z.object({ pairedCount: z.number(), mae: z.number().nullable() }).passthrough() }).passthrough() }).passthrough()) }).passthrough()) }).passthrough() }).passthrough()

/** Compare local per-night HR error for defaults with the pod's own result
 * files (GET /api/biometric-tuning/backtests/{id}/result). */
export function compareWithPod(defaults: LocalFitReport[], podResults: unknown[], toleranceBpm = 0.1) {
  const rows = podResults.flatMap((raw) => {
    const report = podResultSchema.parse(raw).report
    if (report.split === 'holdout') throw new Error('Parity compares tuning and validation results only; holdout results are not compared')
    const local = defaults.find(row => row.split === report.split)
    const defaultsHash = defaults[0]?.candidate.resolvedHash
    const pod = report.numericNightSummary.find(row => row.metric === 'heart_rate' && row.baseline === 'default' && row.baselineHash === defaultsHash)
    if (!pod) throw new Error(`Pod ${report.split} result has no heart-rate summary for the shipped defaults`)
    if (local && local.dataset.contentHash !== report.datasetHash) throw new Error('Pod result is for a different dataset')
    return pod.nights.map((night) => {
      const localNight = local?.summary.heart_rate.nights.find(row => row.cohortId === night.cohortId)
      const podMae = night.commonSupport.baseline.mae, localMae = localNight?.defaultMae ?? null
      const difference = podMae === null || localMae === null ? null : localMae - podMae
      return { split: report.split, cohortId: night.cohortId, podMae, localMae, podPairedCount: night.commonSupport.baseline.pairedCount,
        localPairedCount: localNight?.pairedCount ?? null, difference, withinTolerance: difference !== null && Math.abs(difference) <= toleranceBpm }
    })
  })
  return { version: 'biometrics-local-fit-parity-v1' as const, toleranceBpm, rows, allWithinTolerance: rows.length > 0 && rows.every(row => row.withinTolerance) }
}
