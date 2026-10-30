import { stageObjectivePolicySchema } from '@/src/biometrics/backtest/stage-objective'
import { numericSubgroupNames } from '@/src/biometrics/backtest/numeric-subgroups'
import { jobOperationsSchema } from '@/src/biometrics/backtest/job-operations'
import { waveformResourceSummarySchema } from '@/src/biometrics/backtest/waveform-resources'
import { z } from 'zod'
import { objectivePolicySchema } from '@/src/biometrics/backtest/objective-policy'

const score = z.number().finite().nullable()
const pooled = z.object({ agreement: score, macroF1: score, pairedDurationMs: z.number().nonnegative() })
/** A bounded UI projection of the retained versioned report; unknown versions fail closed. */
export const reportViewSchema = z.object({
  version: z.enum(['processed-backtest-report-v1', 'waveform-backtest-report-v1']), status: z.enum(['insufficient_evidence', 'improved', 'no_material_change', 'regressed', 'incompatible']),
  qualificationWarning: z.string().nullable().optional(),
  jobOperations: jobOperationsSchema.optional(),
  waveform: z.object({ resources: waveformResourceSummarySchema.optional() }).optional(),
  datasetHash: z.string(), protocolHash: z.string(), manifestHash: z.string(), evaluatorBuildHash: z.string(),
  split: z.enum(['tuning', 'validation', 'holdout']), evidence: z.string(), holdoutUse: z.number(),
  protocol: z.object({ mode: z.enum(['comparison', 'stage_replay', 'signal_replay']), waveformStages: z.boolean().optional(), objectivePolicy: objectivePolicySchema.optional(), objectivePolicies: z.array(objectivePolicySchema).min(1).max(3).optional(), stageObjectivePolicy: stageObjectivePolicySchema.optional() }),
  objectiveAssessments: z.array(z.object({ policy: objectivePolicySchema.optional(), baseline: z.string(), candidate: z.string(), status: z.enum(['insufficient_evidence', 'incompatible', 'regressed', 'improved', 'no_material_change']),
    missingEvidence: z.array(z.string()), failedThresholds: z.array(z.string()), designated: z.boolean() })).max(6).optional(),
  stageObjectiveAssessments: z.array(z.object({ baseline: z.string(), candidate: z.string(), status: z.enum(['insufficient_evidence', 'regressed', 'improved', 'no_material_change']),
    missingEvidence: z.array(z.string()), failedThresholds: z.array(z.string()), designated: z.boolean() })).max(2).optional(),
  calibration: z.object({ source: z.literal('explicit_assumption'), quality: z.number() }),
  limitations: z.array(z.string()),
  stageNightSummary: z.array(z.object({ baseline: z.string(), candidate: z.string(), baselineHash: z.string(), candidateHash: z.string(),
    totalNights: z.number(), scoredNights: z.number(), unscoredNights: z.number(), coverageReducedNights: z.number(),
    improvedAgreementNights: z.number(), regressedAgreementNights: z.number(), unchangedAgreementNights: z.number(),
    equalNightMeanAgreementDifference: score,
    pooledCommonSupport: z.object({ baseline: pooled, candidate: pooled }),
    uncertainty: z.object({ status: z.enum(['not_requested', 'insufficient_nights', 'degenerate', 'estimated']),
      interval: z.object({ lower: z.number().finite(), upper: z.number().finite() }).nullable(), limitations: z.array(z.string()) }),
  })).max(3),
}).refine(report => (report.version === 'waveform-backtest-report-v1') === (report.protocol.mode === 'signal_replay'), 'Report mode and version disagree')

const numericMetric = z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1'])
const configuration = z.enum(['default', 'current', 'candidate'])
// Four reference groups × three metrics × three pairwise configuration comparisons.
const maximumNumericSubgroupRows = numericSubgroupNames.length * numericMetric.options.length * 3
const count = z.number().int().nonnegative()
const numericSupport = z.object({
  metrics: z.object({ mae: score, medianAbsoluteError: score, p95AbsoluteError: score, signedBias: score }).nullable(),
  pairedCount: count, referenceCoverage: score,
})
export const numericComparisonViewSchema = z.object({
  version: z.literal('paired-numeric-support-v1'), metric: numericMetric,
  baseline: configuration, candidate: configuration, baselineHash: z.string(), candidateHash: z.string(),
  commonSupportScope: z.literal('all_configurations'), supportDefinition: z.literal('identical_unambiguous_observation_timestamps'),
  commonObservationCount: count,
  ownSupport: z.object({ baseline: numericSupport, candidate: numericSupport }),
  commonSupport: z.object({ baseline: numericSupport, candidate: numericSupport }),
  differences: z.object({ commonMae: score, commonMedianAbsoluteError: score, commonP95AbsoluteError: score,
    commonSignedBias: score, ownMae: score, referenceCoverage: score }),
  lostObservationTimestamps: count, addedObservationTimestamps: count,
  ambiguousObservationTimestamps: z.object({ baseline: count, candidate: count }), coverageReduced: z.boolean(),
  interpretation: z.literal('descriptive_numeric_agreement_not_validated_improvement'),
})
/** Bounded scores only; readings and reference records remain outside this projection. */
export const numericReportViewSchema = z.object({
  numericSubgroupSummary: z.array(z.object({ name: z.enum(numericSubgroupNames), version: z.literal('reference-defined-numeric-subgroups-v1'),
    referenceMembershipBasis: z.literal('native_reference_time'), observationCoverageScope: z.literal('complete_scoring_windows'),
    excludedBoundaryReferenceCount: count,
    summary: z.object({ metric: numericMetric, baseline: configuration, candidate: configuration, baselineHash: z.string(), candidateHash: z.string(),
      scoredNights: count, unscoredNights: count, equalNightMeanMaeDifference: score,
    }),
  })).max(maximumNumericSubgroupRows).optional(),
  numericNightSummary: z.array(z.object({
    version: z.literal('numeric-night-summary-v1'), metric: numericMetric, baseline: configuration, candidate: configuration,
    baselineHash: z.string(), candidateHash: z.string(), totalNights: count, scoredNights: count, unscoredNights: count,
    coverageReducedNights: count, improvedErrorNights: count, regressedErrorNights: count, unchangedErrorNights: count,
    equalNightMeanMaeDifference: score,
    pooledCommonSupport: z.object({ baseline: z.object({ pairedCount: count, mae: score, signedBias: score }),
      candidate: z.object({ pairedCount: count, mae: score, signedBias: score }) }),
    uncertainty: z.object({ statistic: z.literal('equal_night_mean_common_mae_difference'),
      status: z.enum(['not_requested', 'insufficient_nights', 'degenerate', 'estimated']),
      interval: z.object({ lower: z.number().finite(), upper: z.number().finite() }).nullable(), limitations: z.array(z.string()),
    }),
  })).max(9).optional(),
  nights: z.array(z.object({
    cohortId: z.string(),
    numericComparisons: z.array(z.object({ startMs: z.number().finite(), endMs: z.number().finite(),
      metrics: z.array(numericComparisonViewSchema).max(9),
    })).max(60).optional(),
    evaluations: z.array(z.object({
      label: z.enum(['default', 'current', 'candidate']), configHash: z.string(),
      windows: z.array(z.object({
        startMs: z.number().finite(), endMs: z.number().finite(), observationCount: z.number().int().nonnegative(),
        numeric: z.array(z.object({
          metric: z.enum(['heart_rate', 'breathing_rate', 'window_ibi_variability_v1']),
          status: z.enum(['compared', 'no_reference', 'no_overlap', 'incompatible']),
          metrics: z.object({ mae: score, medianAbsoluteError: score, p95AbsoluteError: score, signedBias: score }).nullable(),
          pairedCount: z.number().int().nonnegative(), referenceCoverage: score, outputCoverage: score,
          unmatchedReferences: z.number().int().nonnegative(), unmatchedObservations: z.number().int().nonnegative(),
          exclusions: z.record(z.string(), z.number().int().nonnegative()),
        })).max(3),
      })).max(60),
    })).max(3),
  })).max(60),
})
export type NumericReportView = z.infer<typeof numericReportViewSchema>

const duration = z.number().finite().nonnegative()
const stage = z.enum(['wake', 'light', 'deep', 'rem'])
const matrixRow = z.object({ wake: duration, light: duration, deep: duration, rem: duration })
const stageScore = pooled.extend({
  confusionMs: z.object({ wake: matrixRow, light: matrixRow, deep: matrixRow, rem: matrixRow }),
  perStage: z.array(z.object({ stage, referenceMs: duration, predictedMs: duration, precision: score, recall: score, f1: score })).length(4),
})
const ownSupport = z.object({ outputMs: duration, pairedMs: duration, referenceMs: duration, agreement: score, outputCoverage: score, referenceCoverage: score })
export const stageReportViewSchema = z.object({ stageNightSummary: z.array(z.object({
  baseline: z.string(), candidate: z.string(), baselineHash: z.string(), candidateHash: z.string(),
  pooledCommonSupport: z.object({ baseline: stageScore, candidate: stageScore }),
  nights: z.array(z.object({
    cohortId: z.string(), evaluationDurationMs: duration,
    commonSupport: z.object({ baseline: stageScore, candidate: stageScore }),
    ownSupport: z.object({ baseline: ownSupport, candidate: ownSupport }),
    commonAgreementDifference: score, commonMacroF1Difference: score, coverageReduced: z.boolean(),
  })).max(60),
})).max(3) })
export type StageReportView = z.infer<typeof stageReportViewSchema>
export type StageScoreView = z.infer<typeof stageScore>
