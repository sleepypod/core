import { assessStageObjective } from './stage-objective'
import { numericSubgroupNames, subgroupReferences, subgroupObjectiveEvidence, subgroupBoundaryExclusions } from './numeric-subgroups'
import { summarizeWaveformResources } from './waveform-resources'
import { assessNumericObjective } from './objective-policy'
import { createNumericNightSummary } from './numeric-night-summary'
import { compareNumericConfigurations } from './numeric-comparison'
import { z } from 'zod'
import { waveformEvaluationSchema } from './waveform-output'
import { compareStageOutputs } from './stage-comparison'
import { createNightSummary } from './night-summary-core'
import { createNightUncertainty } from './uncertainty-core'
import { intersectOutputSupport } from './common-support'
import { classifySleepStages, type SleepStageBlock } from '@/src/lib/sleep-stages'
import { biometricManifest, validateConfig } from '../algorithms/registry-core'
import { alignReferences, DEFAULT_ALIGNMENT } from '../references/alignment'
import { scoreStageDurations } from '../references/stage-scoring'
import { datasetSnapshotSchema, backtestJobSnapshotSchema, numericObjectivePolicies } from './contracts'

export { waveformEvaluationSchema } from './waveform-output'

export const backtestWorkSchema = z.object({
  job: backtestJobSnapshotSchema,
  dataset: z.object({ manifest: z.unknown(), snapshot: datasetSnapshotSchema }),
  waveform: waveformEvaluationSchema.optional(),
})
const assignmentsSchema = z.object({ splitProtocol: z.object({ assignments: z.array(z.object({
  cohortId: z.string(), sessionIds: z.array(z.number()), split: z.enum(['tuning', 'validation', 'holdout']), startMs: z.number(), endMs: z.number(),
})) }) })

function mergeWindows(windows: Array<{ startMs: number, endMs: number }>) {
  const merged: typeof windows = []
  for (const window of [...windows].sort((a, b) => a.startMs - b.startMs)) {
    const last = merged.at(-1)
    if (last && last.endMs >= window.startMs) last.endMs = Math.max(last.endMs, window.endMs)
    else merged.push({ ...window })
  }
  return merged
}

/** Pure retained-data evaluator. No DB, network, filesystem or hardware writes. */
export function createBacktestEvaluator(dependencies: { configHash: (value: unknown) => string, dataHash: (value: unknown) => string, digest: (text: string) => Uint8Array }) {
  const { configHash, dataHash, digest } = dependencies
  const manifestHash = configHash(biometricManifest)
  const summarizeNumericNights = createNumericNightSummary(createNightUncertainty(digest, 'equal_night_mean_common_mae_difference'))
  const summarizeStageNights = createNightSummary(createNightUncertainty(digest))
  return function evaluateBacktest(raw: z.input<typeof backtestWorkSchema>, progress: (completed: number, total: number) => void = () => {}) {
    const { job, dataset, waveform } = backtestWorkSchema.parse(raw)
    const signalReplay = job.protocol.mode === 'signal_replay'
    const stages = job.protocol.mode === 'stage_replay' || (signalReplay && job.protocol.waveformStages === true)
    if (dataHash(dataset) !== job.datasetHash || configHash(job.protocol) !== job.protocolHash) throw new Error('Evaluation input integrity mismatch')
    const assignments = assignmentsSchema.parse(dataset.manifest).splitProtocol.assignments.filter(row => row.split === job.split)
    if (!assignments.length) throw new Error('No nights in selected split')
    const configs = job.configs.map((config) => {
      const resolved = validateConfig(config.resolved)
      if (config.manifestHash !== manifestHash || configHash(resolved) !== config.resolvedHash) throw new Error('Evaluation engine/configuration mismatch')
      return { ...config, resolved }
    })
    const waveformOutputs = new Map<string, NonNullable<typeof waveform>['outputs'][number]>()
    if (signalReplay) {
      if (!job.waveform || !waveform || dataset.snapshot.version !== 'waveform-dataset-v1'
        || dataHash(waveform.outputs) !== waveform.hash) throw new Error('Missing or corrupt waveform evaluation inputs')
      const other = validateConfig(job.waveform.otherSide.resolved)
      if (job.waveform.otherSide.manifestHash !== manifestHash || configHash(other) !== job.waveform.otherSide.resolvedHash) throw new Error('Invalid other-side waveform configuration')
      const expectedConfigs = new Set(configs.map(config => config.resolvedHash))
      const otherSide = dataset.snapshot.side === 'left' ? 'right' : 'left'
      for (const output of waveform.outputs) {
        const retained = dataset.snapshot.waveformInputs.find(row => row.cohortId === output.cohortId)
        const key = `${output.cohortId}:${output.configHash}`
        if (!retained || !assignments.some(row => row.cohortId === output.cohortId) || !expectedConfigs.has(output.configHash)
          || waveformOutputs.has(key) || output.run.build_hash !== job.waveform.pythonBuildHash
          || output.run.config_hashes[dataset.snapshot.side] !== output.configHash
          || output.run.config_hashes[otherSide] !== job.waveform.otherSide.resolvedHash
          || output.run.counts.scored_outputs !== output.readings.length
          // A Pod 5 frame can pack several records, so decoded records may outnumber frames but never exist without one.
          || (output.run.raw_records === 0 && output.run.decoded_records > 0) || output.run.decoded_records < output.run.counts.records
          || JSON.stringify(output.run.artifact_hashes) !== JSON.stringify(retained.input.artifacts.map(row => row.artifact.sha256))
          || output.readings.some(row => row.configHash !== output.run.config_hashes[row.side]
            || row.timestampMs < retained.input.score_start_ms || row.timestampMs >= retained.input.score_end_ms)) throw new Error('Waveform output identity mismatch')
        waveformOutputs.set(key, output)
      }
      if (waveformOutputs.size !== assignments.length * expectedConfigs.size) throw new Error('Missing waveform cohort/configuration output')
    }
    else if (waveform || job.waveform) throw new Error('Unexpected waveform inputs for processed replay')
    const references = dataset.snapshot.references.flatMap(source => source.measurements.map(row => ({ ...row, recordKey: `${source.importId}:${row.recordKey}` })))
    const nights = assignments.map((assignment, nightIndex) => {
      const sessions = assignment.sessionIds.map((id) => {
        const session = dataset.snapshot.sessions.find(row => row.id === id)
        if (!session) throw new Error('Retained session missing')
        return session
      })
      const windows = mergeWindows(sessions.map(row => ({ startMs: row.startMs, endMs: row.endMs })))
      const vitals = [...new Map(sessions.flatMap(session => session.vitals).map(row => [row.id, row])).values()].sort((a, b) => a.timestampMs - b.timestampMs)
      const movement = [...new Map(sessions.flatMap(session => session.movement).map(row => [row.id, row])).values()].sort((a, b) => a.timestampMs - b.timestampMs || a.id - b.id)
      // Each unique configuration executes once even when default/current match.
      const computed = new Map<string, ReturnType<typeof evaluateConfig>>()
      const evaluateConfig = (config: typeof configs[number]) => windows.map((window) => {
        if (window.endMs - window.startMs > 86400000) throw new Error('Merged replay window exceeds the one-day evaluation budget')
        const output = waveformOutputs.get(`${assignment.cohortId}:${config.resolvedHash}`)
        const observations = signalReplay
          ? (output?.readings.filter(row => row.side === dataset.snapshot.side).map((row, id) => ({
              id, timestampMs: row.timestampMs, heartRate: row.heartRate, hrv: row.hrvIndex, breathingRate: row.breathingRate, processingRunId: null,
            })) ?? [])
          : vitals
        const rows = observations.filter(row => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)
        const moves = movement.filter(row => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)
        const numeric = (['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const).map((metric) => {
          const aligned = alignReferences(metric, metric === 'window_ibi_variability_v1' ? 300000 : null,
            rows.map(row => ({ timestampMs: row.timestampMs, value: metric === 'heart_rate' ? row.heartRate : metric === 'breathing_rate' ? row.breathingRate : row.hrv })),
            references.filter(row => row.metric === metric && row.startMs >= window.startMs && (row.temporalKind === 'point' ? row.startMs < window.endMs : row.endMs <= window.endMs)),
            { ...DEFAULT_ALIGNMENT, pointToleranceMs: job.protocol.pointToleranceMs, clockOffsetMs: job.protocol.clockOffsetMs })
          // The report stores summaries; full input samples remain in the dataset.
          return { metric, status: aligned.status, metrics: aligned.metrics, pairedCount: aligned.pairedCount,
            referenceCoverage: aligned.referenceCoverage, outputCoverage: aligned.outputCoverage, unmatchedReferences: aligned.unmatchedReferences,
            unmatchedObservations: aligned.unmatchedObservations, exclusions: aligned.exclusions }
        })
        let blocks: SleepStageBlock[] = []
        if (stages) {
          const epochs = classifySleepStages(rows.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })),
            moves.map(row => ({ ...row, timestamp: new Date(row.timestampMs) })), job.protocol.assumedStageCalibrationQuality, config.resolved.sleep_stages.ruleset)
          blocks = epochs.map(epoch => ({ start: epoch.start, end: Math.min(window.endMs, epoch.start + epoch.duration), stage: epoch.stage })).filter(row => row.end > row.start)
        }
        return { ...window, observationCount: rows.length, numeric,
          stage: stages
            ? scoreStageDurations(blocks.map(block => ({ ...block, start: block.start + job.protocol.clockOffsetMs, end: block.end + job.protocol.clockOffsetMs })), references.filter(row => row.metric === 'sleep_stages'), window.startMs, window.endMs)
            : null,
          // Bounded complete traces (the dataset has at most 20k rows).
          blocks,
        }
      })
      const evaluations = configs.map((config) => {
        let windows = computed.get(config.resolvedHash)
        if (!windows) {
          windows = evaluateConfig(config)
          computed.set(config.resolvedHash, windows)
        }
        return { label: config.label, revisionId: config.revisionId, configHash: config.resolvedHash, windows }
      })
      const shift = (blocks: SleepStageBlock[]) => blocks.map(block => ({ ...block,
        start: block.start + job.protocol.clockOffsetMs, end: block.end + job.protocol.clockOffsetMs }))
      const sharedSupport = stages
        ? windows.map((window, index) =>
            intersectOutputSupport(evaluations.map(evaluation => shift(evaluation.windows[index].blocks)), window.startMs, window.endMs))
        : []
      const comparisons = stages
        ? evaluations.flatMap(candidate => evaluations
            .filter(baseline => (candidate.label === 'candidate' && baseline.label !== 'candidate') || (candidate.label === 'current' && baseline.label === 'default'))
            .map(baseline => ({ baseline: baseline.label, candidate: candidate.label,
              baselineHash: baseline.configHash, candidateHash: candidate.configHash,
              windows: candidate.windows.map((window, index) => {
                return { startMs: window.startMs, endMs: window.endMs,
                  ...compareStageOutputs(shift(baseline.windows[index].blocks), shift(window.blocks),
                    references.filter(row => row.metric === 'sleep_stages'), window.startMs, window.endMs, sharedSupport[index]) }
              }),
            })))
        : []
      const compareWindow = (window: typeof windows[number], metric: 'heart_rate' | 'breathing_rate' | 'window_ibi_variability_v1', selectedReferences: typeof references) => compareNumericConfigurations(
        metric, metric === 'window_ibi_variability_v1' ? 300000 : null,
        configs.map(config => ({ label: config.label, configHash: config.resolvedHash,
          observations: (waveformOutputs.get(`${assignment.cohortId}:${config.resolvedHash}`)?.readings ?? [])
            .filter(row => row.side === dataset.snapshot.side && row.timestampMs >= window.startMs && row.timestampMs < window.endMs)
            .map(row => ({ timestampMs: row.timestampMs, value: metric === 'heart_rate' ? row.heartRate : metric === 'breathing_rate' ? row.breathingRate : row.hrvIndex })),
        })), selectedReferences,
        { ...DEFAULT_ALIGNMENT, pointToleranceMs: job.protocol.pointToleranceMs, clockOffsetMs: job.protocol.clockOffsetMs })
      const windowReferences = (window: typeof windows[number], metric: string) => references.filter(row => row.metric === metric && row.startMs >= window.startMs
        && (row.temporalKind === 'point' ? row.startMs < window.endMs : row.endMs <= window.endMs))
      const numericComparisons = signalReplay
        ? windows.map(window => ({ ...window,
            metrics: (['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'] as const).flatMap(metric => compareWindow(window, metric, windowReferences(window, metric))),
          }))
        : []
      const subgroupMetrics = numericObjectivePolicies(job.protocol).map(policy => policy.metric)
      const numericSubgroups = signalReplay && subgroupMetrics.length
        ? numericSubgroupNames.map(name => ({ name, numericComparisons: windows.map(window => ({ ...window,
            metrics: subgroupMetrics.flatMap(metric => compareWindow(window, metric, subgroupReferences(name, windowReferences(window, metric), window))),
            excludedBoundaryReferenceCount: subgroupMetrics.reduce((sum, metric) => sum + subgroupBoundaryExclusions(name, windowReferences(window, metric), window), 0),
            excludedByMetric: Object.fromEntries(subgroupMetrics.map(metric => [metric, subgroupBoundaryExclusions(name, windowReferences(window, metric), window)])),
          })) }))
        : []
      progress(nightIndex + 1, assignments.length)
      return { cohortId: assignment.cohortId, sessionIds: assignment.sessionIds,
        uniqueObservationCount: signalReplay
          ? new Set([...waveformOutputs.values()].filter(output => output.cohortId === assignment.cohortId)
            .flatMap(output => output.readings.filter(row => row.side === dataset.snapshot.side
              && windows.some(window => row.timestampMs >= window.startMs && row.timestampMs < window.endMs)).map(row => row.timestampMs))).size
          : vitals.length,
        ...(signalReplay ? { numericComparisons, numericSubgroups, recordedObservationCount: vitals.length, observationCountBasis: 'union_of_derived_timestamps' } : {}), evaluations, comparisons }
    })
    const stageNightSummary = summarizeStageNights(nights, job.protocol.nightUncertainty)
    const stagePolicy = job.protocol.stageObjectivePolicy
    const stageObjectiveAssessments = stagePolicy
      ? stageNightSummary.filter(row => row.candidate === 'candidate').map(summary => ({
          baseline: summary.baseline, candidate: summary.candidate, baselineHash: summary.baselineHash, candidateHash: summary.candidateHash,
          ...assessStageObjective(stagePolicy, { split: job.split, holdoutUse: job.holdoutUse, intervalLower: summary.uncertainty.interval?.lower ?? null, operational: null,
            nights: summary.nights.map(night => ({ cohortId: night.cohortId, pairedDurationMs: night.commonSupport.candidate.pairedDurationMs,
              agreementDifference: night.commonAgreementDifference, macroF1Difference: night.commonMacroF1Difference,
              candidateOutputCoverage: night.ownSupport.candidate.outputCoverage, baselineOutputMs: night.ownSupport.baseline.outputMs, commonOutputMs: night.commonOutputDurationMs,
              perStage: night.commonSupport.candidate.perStage.map((row) => {
                const baseline = night.commonSupport.baseline.perStage.find(item => item.stage === row.stage)
                return { stage: row.stage, referenceMs: row.referenceMs, f1Difference: row.f1 === null || baseline?.f1 == null ? null : row.f1 - baseline.f1 }
              }),
            })),
          }, null),
        }))
      : []
    const numericNightSummary = signalReplay ? summarizeNumericNights(nights, job.protocol.nightUncertainty) : []
    const numericSubgroupSummary = signalReplay && numericObjectivePolicies(job.protocol).length
      ? numericSubgroupNames.flatMap(name => summarizeNumericNights(nights.map(night => ({ cohortId: night.cohortId,
          numericComparisons: night.numericSubgroups?.find(group => group.name === name)?.numericComparisons })))
          .map(summary => ({ name, version: 'reference-defined-numeric-subgroups-v1' as const,
            referenceMembershipBasis: 'native_reference_time' as const, observationCoverageScope: 'complete_scoring_windows' as const,
            excludedBoundaryReferenceCount: nights.reduce((sum, night) => sum + (night.numericSubgroups?.find(group => group.name === name)?.numericComparisons.reduce((count, window) => count + (window.excludedByMetric[summary.metric] ?? 0), 0) ?? 0), 0), summary })))
      : []
    const objectiveAssessments = numericObjectivePolicies(job.protocol).flatMap(objectivePolicy => numericNightSummary
      .filter(summary => summary.metric === objectivePolicy.metric && summary.candidate === 'candidate')
      .map(summary => ({ baseline: summary.baseline, candidate: summary.candidate, baselineHash: summary.baselineHash, candidateHash: summary.candidateHash,
        ...assessNumericObjective(objectivePolicy, {
          metricCompatible: !nights.some(night => night.numericComparisons?.some(window => window.metrics.some(row => row.metric === summary.metric
            && row.baseline === summary.baseline && row.candidate === summary.candidate && row.commonSupport.candidate.status === 'incompatible'))),
          split: job.split, holdoutUse: job.holdoutUse,
          nights: summary.nights.map(night => ({ cohortId: night.cohortId, pairedReferences: night.commonSupport.candidate.pairedCount,
            maeDifference: night.commonMaeDifference, lostObservations: night.lostObservationTimestamps,
            baselineObservationCount: nights.find(row => row.cohortId === night.cohortId)?.numericComparisons?.reduce((sum, window) => sum
              + (window.metrics.find(row => row.metric === summary.metric && row.baseline === summary.baseline && row.candidate === summary.candidate)?.ownSupport.baseline.validObservationCount ?? 0), 0) ?? 0 })),
          intervalUpper: summary.uncertainty.interval?.upper ?? null,
          subgroups: subgroupObjectiveEvidence(numericSubgroupSummary.map(group => ({ ...group.summary, name: group.name })), summary, objectivePolicy.minimumPairedReferencesPerNight), operational: null,
        }, null),
      })))
    return { side: dataset.snapshot.side, version: signalReplay ? 'waveform-backtest-report-v1' as const : 'processed-backtest-report-v1' as const,
      ...(signalReplay ? { waveform: { ...(job.waveform?.baselineProvenance ? { baselineProvenance: job.waveform.baselineProvenance } : {}), pythonBuildHash: job.waveform?.pythonBuildHash, otherSideConfigHash: job.waveform?.otherSide.resolvedHash, ...waveform, resources: summarizeWaveformResources(waveform?.outputs ?? []) } } : {}), datasetId: job.datasetId, datasetHash: job.datasetHash,
      evaluatorBuildHash: job.evaluatorBuildHash, protocol: job.protocol, protocolHash: job.protocolHash, manifestHash, support: signalReplay ? 'identical_retained_waveform_inputs' as const : 'identical_retained_epoch_intervals' as const, split: job.split, holdoutUse: job.holdoutUse,
      ...(signalReplay ? { numericNightSummary, numericSubgroupSummary } : {}),
      objectiveAssessments, stageObjectiveAssessments,
      status: 'insufficient_evidence' as const, evidence: job.evidence, nights, stageNightSummary,
      calibration: { source: 'explicit_assumption' as const, quality: job.protocol.assumedStageCalibrationQuality },
      limitations: ['Only a qualified, complete independent evaluation can establish improvement in reference agreement.',
        ...(signalReplay ? ['Numeric comparisons retain own-support scores and scores on observation timestamps shared by all configurations; coverage loss and ambiguous timestamps are reported separately. Common-support differences require qualified objective and coverage assessment before they support promotion.'] : []),
        signalReplay
          ? 'Numeric readings are replayed from retained waveforms; missing historical context, event-time substitution and cold starts constrain parity.'
          : 'Numeric readings are original observations; parameter changes to waveform processing are not evaluated by processed-data replay.',
        'Stages use the shared retrospective classifier, including its bounded gap-duration semantics; they are not causal predictions.',
        'Calibration quality is an explicit assumption, not recovered historical sensor calibration.',
        'Overlapping sessions share one input set; disconnected sessions are classified separately.',
        'Holdout exposure must be rechecked before any later promotion decision.'],
    }
  }
}
