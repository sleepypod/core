// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { configHash, dataHash } from '../../algorithms/canonical'
import { defaultConfig } from '../../algorithms/registry'
import { classifySleepStages } from '@/src/lib/sleep-stages'
import { evaluateBacktest } from '../evaluator'

import { backtestFixture as fixture } from './fixtures/backtest'
import { stageObjectiveTestPolicy } from './fixtures/stage-objective'
import { pythonBuildHash, waveformBacktestFixture } from './fixtures/waveform'
const start = 1791673200000

describe('retained-data evaluator', () => {
  it('deduplicates overlapping sessions, preserves shared classifier behavior and does not mutate input', () => {
    const input = fixture(), before = JSON.stringify(input)
    const report = evaluateBacktest(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(report.nights[0].uniqueObservationCount).toBe(10)
    const windows = report.nights[0].evaluations[0].windows
    expect(windows).toEqual(report.nights[0].evaluations[1].windows)
    const expected = classifySleepStages(input.dataset.snapshot.sessions[0].vitals.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })), [], 0)
    expect(windows[0].blocks).toEqual(expected.map(epoch => ({ start: epoch.start, end: Math.min(start + 600000, epoch.start + epoch.duration), stage: epoch.stage })))
    expect(windows[0].stage).toMatchObject({ pairedDurationMs: 600000, agreement: 1 })
    expect(windows[0].numeric[0]).toMatchObject({ metrics: { mae: 2 }, pairedCount: 1 })
    expect(report.status).toBe('insufficient_evidence')
    expect(report.stageNightSummary).toMatchObject([{ totalNights: 1, scoredNights: 1, equalNightMeanAgreementDifference: 0 }])
    expect(report.nights[0].comparisons).toMatchObject([{ baseline: 'default', candidate: 'current', windows: [{ commonSupportScope: 'all_configurations', coverageReduced: false, differences: { commonAgreement: 0 } }] }])
  })
  it('rejects changed retained inputs and engine snapshots before evaluation', () => {
    const input = fixture()
    input.dataset.snapshot.sessions[0].vitals[0].heartRate = 100
    expect(() => evaluateBacktest(input)).toThrow('integrity mismatch')
    const wrongEngine = fixture()
    wrongEngine.job.configs[0].manifestHash = '0'.repeat(64)
    expect(() => evaluateBacktest(wrongEngine)).toThrow('engine/configuration mismatch')
  })
  it('honors fixed offsets for stage duration scoring without relabeling the original trace', () => {
    const input = fixture()
    input.job.protocol.clockOffsetMs = 60000
    input.job.protocolHash = configHash(input.job.protocol)
    const report = evaluateBacktest(input)
    expect(report.nights[0].evaluations[0].windows[0].stage?.pairedDurationMs).toBe(540000)
    expect(report.nights[0].comparisons[0].windows[0].commonSupport.baseline.pairedDurationMs).toBe(540000)
    expect(report.nights[0].comparisons[0].windows[0].commonSupport.candidate.pairedDurationMs).toBe(540000)
    expect(report.nights[0].evaluations[0].windows[0].blocks[0].start).toBe(start)
  })
  it('uses the frozen uncertainty policy while retaining insufficient-evidence status', () => {
    const input = fixture()
    const protocol = { ...input.job.protocol, nightUncertainty: { version: 'paired-night-percentile-v1' as const,
      seed: 'retained-policy', resamples: 200, minimumNights: 3 } }
    const report = evaluateBacktest({ ...input, job: { ...input.job, protocol, protocolHash: configHash(protocol) } })
    expect(report.stageNightSummary[0].uncertainty).toMatchObject({ policy: protocol.nightUncertainty,
      status: 'insufficient_nights', scoredNights: 1, interval: null })
    expect(report.status).toBe('insufficient_evidence')
  })
  it('applies the shared three-configuration support to every reported comparison', () => {
    const input = fixture()
    const candidate = { ...input.job.configs[0], label: 'candidate' as const }
    const report = evaluateBacktest({ ...input, job: { ...input.job, configs: [...input.job.configs, candidate] } })
    expect(report.nights[0].comparisons).toHaveLength(3)
    for (const comparison of report.nights[0].comparisons) {
      expect(comparison.windows[0]).toMatchObject({ commonSupportScope: 'all_configurations',
        commonSupport: { baseline: { pairedDurationMs: 600000 }, candidate: { pairedDurationMs: 600000 } } })
    }
  })
})

describe('retained waveform evaluator', () => {
  const rehash = <T extends ReturnType<typeof waveformBacktestFixture>>(input: T) => ({ ...input,
    job: { ...input.job, datasetHash: dataHash(input.dataset), protocolHash: configHash(input.job.protocol) }, waveform: { ...input.waveform, hash: dataHash(input.waveform.outputs) } })
  it('replays retained waveform outputs with numeric comparisons, subgroups and objective assessments', () => {
    const input = waveformBacktestFixture({ candidate: true, stages: true, objective: true })
    const protocol = { ...input.job.protocol, stageObjectivePolicy: stageObjectiveTestPolicy,
      nightUncertainty: { version: 'paired-night-percentile-v1' as const, seed: 'fixture', resamples: 200, minimumNights: 3 } }
    const progress: number[] = []
    const report = evaluateBacktest(rehash({ ...input, job: { ...input.job, protocol } }), completed => progress.push(completed))
    expect(progress).toEqual([1])
    expect(report).toMatchObject({ version: 'waveform-backtest-report-v1', support: 'identical_retained_waveform_inputs', status: 'insufficient_evidence',
      waveform: { pythonBuildHash, otherSideConfigHash: configHash(defaultConfig), resources: { expectedProcesses: 2, measuredProcesses: 0 } } })
    expect(report.limitations).toHaveLength(7)
    const night = report.nights[0]
    expect(night).toMatchObject({ uniqueObservationCount: 10, recordedObservationCount: 10, observationCountBasis: 'union_of_derived_timestamps' })
    expect(night.evaluations.map(row => row.windows[0].observationCount)).toEqual([10, 10, 10])
    expect(night.evaluations[2].windows[0].numeric[0]).toMatchObject({ metric: 'heart_rate', pairedCount: 1, metrics: { mae: 1 } })
    expect(night.evaluations[0].windows[0].stage).not.toBeNull()
    expect(night.comparisons).toHaveLength(3)
    expect(night.numericComparisons?.[0].metrics.map(row => [row.metric, row.baseline, row.candidate])).toEqual(expect.arrayContaining([['heart_rate', 'default', 'candidate'], ['breathing_rate', 'current', 'candidate']]))
    expect(night.numericSubgroups?.map(group => group.name)).toEqual(['reference_points', 'reference_intervals', 'window_first_half', 'window_second_half'])
    expect(night.numericSubgroups?.[0].numericComparisons[0]).toMatchObject({ excludedBoundaryReferenceCount: 0, excludedByMetric: { heart_rate: 0 } })
    expect(report.numericNightSummary?.length).toBeGreaterThan(0)
    expect(report.numericSubgroupSummary?.[0]).toMatchObject({ name: 'reference_points', version: 'reference-defined-numeric-subgroups-v1', excludedBoundaryReferenceCount: 0 })
    expect(report.objectiveAssessments).toHaveLength(2)
    expect(report.objectiveAssessments[0]).toMatchObject({ candidate: 'candidate', status: 'insufficient_evidence', evidence: { metricCompatible: true, nights: [{ cohortId: 'night', pairedReferences: 1, baselineObservationCount: 10 }] } })
    expect(report.stageObjectiveAssessments).toHaveLength(2)
    expect(report.stageObjectiveAssessments[0]).toMatchObject({ candidate: 'candidate', status: 'insufficient_evidence', evidence: { nights: [{ cohortId: 'night', perStage: expect.arrayContaining([{ stage: 'light', referenceMs: 600000, f1Difference: 0 }]) }] } })
  })
  it('replays waveform numerics without stages when downstream stage replay is not requested', () => {
    const input = waveformBacktestFixture()
    const report = evaluateBacktest({ ...input, job: { ...input.job, waveform: { ...input.job.waveform, baselineProvenance: {
      current: { source: 'acknowledged_runtime', generation: 1, effectiveSampleTimeMs: start, warning: null },
      otherSide: { source: 'unacknowledged_defaults', generation: null, effectiveSampleTimeMs: null, warning: 'defaults' } } } } })
    expect(report.waveform?.baselineProvenance?.otherSide.source).toBe('unacknowledged_defaults')
    expect(report.nights[0].evaluations[0].windows[0]).toMatchObject({ stage: null, blocks: [] })
    expect(report.nights[0]).toMatchObject({ comparisons: [], numericSubgroups: [] })
    expect(report.nights[0].numericComparisons?.[0].metrics.map(row => [row.metric, row.baseline, row.candidate])).toEqual([['heart_rate', 'default', 'current'], ['breathing_rate', 'default', 'current'], ['window_ibi_variability_v1', 'default', 'current']])
    expect(report).toMatchObject({ stageNightSummary: [], objectiveAssessments: [], stageObjectiveAssessments: [], numericSubgroupSummary: [] })
    expect(report.nights[0].uniqueObservationCount).toBe(10)
  })
  it('rejects waveform inputs that do not match the frozen job identity', () => {
    const base = waveformBacktestFixture()
    expect(() => evaluateBacktest({ ...base, waveform: undefined })).toThrow('Missing or corrupt waveform evaluation inputs')
    expect(() => evaluateBacktest({ ...base, waveform: { ...base.waveform, hash: '0'.repeat(64) } })).toThrow('Missing or corrupt waveform evaluation inputs')
    const otherSide = { ...base.job.waveform.otherSide, resolvedHash: '0'.repeat(64) }
    expect(() => evaluateBacktest({ ...base, job: { ...base.job, waveform: { ...base.job.waveform, otherSide } } })).toThrow('Invalid other-side waveform configuration')
    expect(() => evaluateBacktest(rehash({ ...base, waveform: { ...base.waveform, outputs: [] } }))).toThrow('Missing waveform cohort/configuration output')
    const output = base.waveform.outputs[0]
    for (const bad of [
      { ...output, cohortId: 'other' },
      { ...output, run: { ...output.run, build_hash: '0'.repeat(64) } },
      { ...output, run: { ...output.run, config_hashes: { ...output.run.config_hashes, right: '0'.repeat(64) } } },
      { ...output, run: { ...output.run, counts: { ...output.run.counts, scored_outputs: 1 } } },
      { ...output, run: { ...output.run, raw_records: 0 } },
      { ...output, run: { ...output.run, artifact_hashes: ['c'.repeat(64)] } },
      { ...output, readings: output.readings.map(row => ({ ...row, timestampMs: row.timestampMs + 600000 })) },
      { ...output, configHash: 'c'.repeat(64), readings: output.readings.map(row => ({ ...row, configHash: 'c'.repeat(64) })) },
    ]) {
      expect(() => evaluateBacktest(rehash({ ...base, waveform: { ...base.waveform, outputs: [bad] } }))).toThrow('Waveform output identity mismatch')
    }
    expect(() => evaluateBacktest(rehash({ ...base, waveform: { ...base.waveform, outputs: [output, output] } }))).toThrow('Waveform output identity mismatch')
    // Pod 5 frames pack several records, so fewer frames than decoded records is valid.
    expect(() => evaluateBacktest(rehash({ ...base, waveform: { ...base.waveform, outputs: [{ ...output, run: { ...output.run, raw_records: 1 } }] } }))).not.toThrow('Waveform output identity mismatch')
    const processed = fixture()
    expect(() => evaluateBacktest({ ...processed, waveform: base.waveform })).toThrow('Unexpected waveform inputs for processed replay')
  })
  it('rejects empty splits, missing sessions and replay windows beyond one day', () => {
    const empty = fixture()
    expect(() => evaluateBacktest({ ...empty, job: { ...empty.job, split: 'holdout' } })).toThrow('No nights in selected split')
    const missing = fixture()
    missing.dataset.manifest.splitProtocol.assignments[0].sessionIds = [1, 3]
    missing.job.datasetHash = dataHash(missing.dataset)
    expect(() => evaluateBacktest(missing)).toThrow('Retained session missing')
    const long = fixture()
    long.dataset.snapshot.sessions[1].endMs = start + 86400001
    long.job.datasetHash = dataHash(long.dataset)
    expect(() => evaluateBacktest(long)).toThrow('one-day evaluation budget')
    const source = fixture()
    const protocol = { ...source.job.protocol, mode: 'comparison' as const }
    const night = evaluateBacktest({ ...source, job: { ...source.job, protocol, protocolHash: configHash(protocol) } }).nights[0]
    expect(night.comparisons).toEqual([])
    expect(night.evaluations[0].windows[0]).toMatchObject({ stage: null, blocks: [] })
  })
})
