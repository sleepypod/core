import { dateInTimeZone } from '@/src/lib/timeZoneDate'
import { EXPERIMENT_MEANINGFUL_COMFORT_DIFFERENCE, EXPERIMENT_MINIMUM_EXPOSURE_MS,
  EXPERIMENT_MINIMUM_PAIRS, EXPERIMENT_MINIMUM_TARGET_FRACTION,
  type ExperimentArm, type ExperimentExposure, type ExperimentNight, type ExperimentPlan, type ExperimentRecord } from './contract'
import { checkedExperimentRecord, experimentNights, experimentPlanHash } from './plan'

export type ExperimentExclusion = 'missing_exposure' | 'source_withdrawn' | 'context_changed' | 'preview_only'
  | 'wrong_window' | 'wake_overlap' | 'wrong_target' | 'insufficient_coverage'
  | 'manual_change' | 'uncertain_command' | 'safety_interruption' | 'ambiguous_sleeper'
  | 'missing_feedback' | 'partial_night' | 'invalid_feedback_clock' | 'settling_unverified'

/** Report every exclusion; neither missing feedback nor unobserved targets count as success. */
export function experimentExposureIssues(plan: ExperimentPlan, night: ExperimentNight,
  exposure: ExperimentExposure | undefined): ExperimentExclusion[] {
  if (!exposure) return ['missing_exposure']
  const issues: ExperimentExclusion[] = []
  if (exposure.execution !== 'active') issues.push('preview_only')
  if (exposure.sourceState !== 'current') issues.push('source_withdrawn')
  if (exposure.planHash !== experimentPlanHash(plan) || exposure.bindingHash !== plan.context.bindingHash
    || exposure.routineHash !== plan.context.routineHash || exposure.wakeHash !== plan.context.wakeHash) issues.push('context_changed')
  const scheduled = plan.version === 2 ? plan.schedule.windows.find(window => window.date === night.date) : null
  if (exposure.nightDate !== night.date || dateInTimeZone(exposure.windowStart, plan.context.timezone) !== night.date
    || exposure.windowStart < plan.createdAt || (scheduled && (exposure.windowStart !== scheduled.windowStart
      || exposure.windowEnd !== scheduled.windowEnd || exposure.wakeStartsAt !== (scheduled.wake?.startsAt ?? null)))) issues.push('wrong_window')
  if (exposure.wakeStartsAt !== null && exposure.windowEnd > exposure.wakeStartsAt) issues.push('wake_overlap')
  if (exposure.targetF !== night.targetF) issues.push('wrong_target')
  const windowMs = exposure.windowEnd - exposure.windowStart
  if (exposure.qualifiedMs < EXPERIMENT_MINIMUM_EXPOSURE_MS
    || exposure.observedMs / windowMs < EXPERIMENT_MINIMUM_TARGET_FRACTION
    || exposure.matchedTargetMs / windowMs < EXPERIMENT_MINIMUM_TARGET_FRACTION
    || exposure.qualifiedMs / windowMs < EXPERIMENT_MINIMUM_TARGET_FRACTION) issues.push('insufficient_coverage')
  if (exposure.manualChanges > 0) issues.push('manual_change')
  if (exposure.unconfirmedCommands > 0) issues.push('uncertain_command')
  if (exposure.safetyInterruptions > 0) issues.push('safety_interruption')
  if (exposure.attributionAmbiguous) issues.push('ambiguous_sleeper')
  return issues
}

export interface ExperimentNightResult extends ExperimentNight {
  usable: boolean
  exclusions: ExperimentExclusion[]
  comfort: number | null
  unwantedAdjustments: number | null
  problem: boolean | null
}

export interface ExperimentComparison {
  nights: ExperimentNightResult[]
  arms: Record<ExperimentArm, { assigned: number, scored: number, usable: number, missing: number, meanComfort: number | null }>
  pairedDifferences: { pair: number, comfort: number, unwantedAdjustments: number }[]
  meanPairedComfortDifference: number | null
  recommendation: 'consider_variant' | 'keep_baseline' | 'inconclusive'
  reason: string
  interpretation: 'personal_comfort_comparison_not_sleep_or_causal_proof'
}

function usableNight(night: ExperimentNightResult): night is ExperimentNightResult & { comfort: number, unwantedAdjustments: number } {
  return night.usable && night.comfort !== null && night.unwantedAdjustments !== null
}

/** Paired complete observations only; adverse feedback remains visible even on excluded nights. */
export function compareExperiment(input: ExperimentRecord): ExperimentComparison {
  const record = checkedExperimentRecord(input), plan = record.plan
  const scheduled = experimentNights(plan)
  const exposures = new Map(record.exposures.map(value => [value.nightDate, value]))
  const feedback = new Map(record.feedback.map(value => [value.nightDate, value]))
  const nights: ExperimentNightResult[] = scheduled.map((night, index) => {
    const exposure = exposures.get(night.date), report = feedback.get(night.date)
    const exclusions = experimentExposureIssues(plan, night, exposure)
    if (!report) exclusions.push('missing_feedback')
    else {
      if (!report.confirmedFullNight) exclusions.push('partial_night')
      if (!exposure || report.recordedAt < exposure.windowEnd
        || report.recordedAt > exposure.windowEnd + 14 * 86_400_000) exclusions.push('invalid_feedback_clock')
    }
    if (night.role === 'scored') {
      const settling = scheduled[index - 1]
      if (experimentExposureIssues(plan, settling, exposures.get(settling.date)).length > 0) exclusions.push('settling_unverified')
    }
    return { ...night, usable: night.role === 'scored' && exclusions.length === 0, exclusions,
      comfort: report?.comfort ?? null, unwantedAdjustments: report?.unwantedAdjustments ?? null, problem: report?.problem ?? null }
  })
  const summarize = (arm: ExperimentArm) => {
    const assigned = nights.filter(night => night.arm === arm), scored = assigned.filter(night => night.role === 'scored')
    const usable = scored.filter(usableNight)
    return { assigned: assigned.length, scored: scored.length, usable: usable.length, missing: scored.length - usable.length,
      meanComfort: usable.length ? usable.reduce((sum, night) => sum + night.comfort, 0) / usable.length : null }
  }
  const pairedDifferences = plan.orders.flatMap((_, pair) => {
    const baseline = nights.filter(usableNight).find(night => night.pair === pair && night.arm === 'baseline')
    const variant = nights.filter(usableNight).find(night => night.pair === pair && night.arm === 'variant')
    return baseline && variant
      ? [{ pair, comfort: variant.comfort - baseline.comfort,
          unwantedAdjustments: variant.unwantedAdjustments - baseline.unwantedAdjustments }]
      : []
  })
  const arms = { baseline: summarize('baseline'), variant: summarize('variant') }
  const meanPairedComfortDifference = pairedDifferences.length
    ? pairedDifferences.reduce((sum, pair) => sum + pair.comfort, 0) / pairedDifferences.length
    : null
  let recommendation: ExperimentComparison['recommendation'] = 'inconclusive'
  let reason = 'At least three complete pairs, verified settling periods and morning feedback are needed.'
  // Never adopt a setting early, or hide a bad result behind an exposure exclusion.
  const complete = record.status !== 'stopped' && nights.every(night => feedback.has(night.date))
    && exposures.size === scheduled.length
  const reportedProblem = nights.some(night => night.problem || (night.unwantedAdjustments ?? 0) > 0)
    || record.exposures.some(exposure => exposure.safetyInterruptions > 0)
  if (reportedProblem) {
    reason = 'A problem or unwanted adjustment was reported. Keep your current plan while reviewing it.'
    recommendation = 'keep_baseline'
  }
  else if (!complete) reason = 'The planned comparison is incomplete. No new setting is recommended.'
  else if (arms.baseline.usable !== arms.variant.usable) reason = 'Missing or excluded nights differ between settings. Review the gaps before drawing a preference.'
  else if (pairedDifferences.length >= EXPERIMENT_MINIMUM_PAIRS && meanPairedComfortDifference !== null) {
    const consistent = pairedDifferences.filter(pair => pair.comfort > 0).length >= Math.ceil(pairedDifferences.length * 0.75)
    if (meanPairedComfortDifference >= EXPERIMENT_MEANINGFUL_COMFORT_DIFFERENCE && consistent) {
      recommendation = 'consider_variant'
      reason = 'The nearby setting received consistently better comfort ratings. Review it before changing your routine; this does not establish better sleep.'
    }
    else {
      recommendation = 'keep_baseline'
      reason = 'The nearby setting did not show a consistent one-point comfort advantage. Keep your current routine.'
    }
  }
  return { nights, arms, pairedDifferences, meanPairedComfortDifference, recommendation, reason,
    interpretation: 'personal_comfort_comparison_not_sleep_or_causal_proof' }
}
