// @vitest-environment node
import { expect, it } from 'vitest'
import { configHash } from '@/src/biometrics/algorithms/canonical'
import { evaluateBacktest } from '@/src/biometrics/backtest/evaluator'
import { backtestFixture } from '@/src/biometrics/backtest/tests/fixtures/backtest'
import { waveformBacktestFixture } from '@/src/biometrics/backtest/tests/fixtures/waveform'
import { reportViewSchema, numericReportViewSchema, stageReportViewSchema } from '../report-view'

it('accepts actual stage and stored-reading reports without retaining detailed traces in the summary projection', () => {
  const input = backtestFixture()
  const stage = reportViewSchema.parse(evaluateBacktest(input))
  expect(stage.stageNightSummary[0].equalNightMeanAgreementDifference).toBe(0)
  expect(stage).not.toHaveProperty('nights')
  const stages = stageReportViewSchema.parse(evaluateBacktest(input))
  expect(stages.stageNightSummary[0].nights[0].commonSupport.baseline.pairedDurationMs).toBe(600000)
  const numeric = numericReportViewSchema.parse(evaluateBacktest(input))
  expect(numeric.nights[0].evaluations[0].windows[0].numeric[0].metrics?.mae).toBe(2)
  expect(numeric.nights[0].evaluations[0].windows[0]).not.toHaveProperty('blocks')
  const protocol = { ...input.job.protocol, mode: 'comparison' as const }
  const comparison = reportViewSchema.parse(evaluateBacktest({ ...input, job: { ...input.job, protocol, protocolHash: configHash(protocol) } }))
  expect(comparison.protocol.mode).toBe('comparison')
  expect(comparison.stageNightSummary).toEqual([])
})
it('rejects mismatched report mode and version', () => {
  const report = evaluateBacktest(backtestFixture())
  expect(reportViewSchema.safeParse({ ...report, version: 'waveform-backtest-report-v1' }).success).toBe(false)
  expect(reportViewSchema.safeParse({ ...report, protocol: { mode: 'signal_replay' } }).success).toBe(false)
  expect(reportViewSchema.safeParse({ ...report, version: 'waveform-backtest-report-v1', protocol: { mode: 'signal_replay', waveformStages: false } }).success).toBe(true)
})

it.each([1, 2, 3])('accepts all reference-defined subgroup rows for %i numeric objectives', (metricCount) => {
  const work = waveformBacktestFixture({ candidate: true, objective: true })
  const policy = work.job.protocol.objectivePolicies?.[0]
  if (!policy) throw new Error('The waveform fixture must include a numeric objective')
  const metrics = (['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const).slice(0, metricCount)
  work.job.protocol.objectivePolicies = metrics.map(metric => ({ ...policy, metric }))
  work.job.protocolHash = configHash(work.job.protocol)
  const report = evaluateBacktest(work)
  expect(report.numericSubgroupSummary).toHaveLength(metricCount * 12)

  const projection = numericReportViewSchema.parse(report)
  expect(projection.numericSubgroupSummary).toHaveLength(metricCount * 12)
  for (const metric of metrics) {
    const rows = (projection.numericSubgroupSummary ?? []).filter(group => group.summary.metric === metric)
    expect(rows).toHaveLength(12)
    expect(new Set(rows.map(group => group.name)).size).toBe(4)
    expect(new Set(rows.map(group => `${group.summary.baseline}:${group.summary.candidate}`)).size).toBe(3)
    expect(rows[0].summary).not.toHaveProperty('nights')
  }
})

it('retains a finite subgroup bound and rejects an unsupported metric', () => {
  const report = evaluateBacktest(waveformBacktestFixture({ candidate: true, objective: true }))
  const group = report.numericSubgroupSummary?.[0]
  if (!group) throw new Error('The waveform fixture must include subgroup summaries')
  const oversized = numericReportViewSchema.safeParse({ ...report, numericSubgroupSummary: Array.from({ length: 37 }, () => group) })
  expect(oversized.success).toBe(false)
  if (!oversized.success) expect(oversized.error.issues).toContainEqual(expect.objectContaining({ code: 'too_big', maximum: 36, path: ['numericSubgroupSummary'] }))
  expect(numericReportViewSchema.safeParse({ ...report, numericSubgroupSummary: [{ ...group, summary: { ...group.summary, metric: 'unsupported' } }] }).success).toBe(false)
})
