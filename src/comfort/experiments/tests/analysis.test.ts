import { describe, expect, it } from 'vitest'
import { compareExperiment, type ExperimentExclusion } from '../analysis'
import type { ExperimentExposure } from '../contract'
import { completeExperiment } from './fixture'

describe('personal comfort comparisons', () => {
  it('uses paired scored nights while retaining all settling observations', () => {
    const result = compareExperiment(completeExperiment())
    expect(result.arms.baseline).toEqual({ assigned: 8, scored: 4, usable: 4, missing: 0, meanComfort: 6 })
    expect(result.arms.variant.meanComfort).toBe(8)
    expect(result.pairedDifferences).toHaveLength(4)
    expect(result.meanPairedComfortDifference).toBe(2)
    expect(result.recommendation).toBe('consider_variant')
    expect(result.interpretation).toBe('personal_comfort_comparison_not_sleep_or_causal_proof')
  })

  it('does not select a winner from an incomplete or stopped comparison', () => {
    const record = completeExperiment()
    record.feedback.pop()
    expect(compareExperiment(record).recommendation).toBe('inconclusive')
    const stopped = completeExperiment()
    stopped.status = 'stopped'
    stopped.stoppedAt = stopped.updatedAt
    expect(compareExperiment(stopped).recommendation).toBe('inconclusive')
  })

  it('requires a meaningful and consistent preference, not just the highest mean', () => {
    const record = completeExperiment()
    record.feedback[3].comfort = 2
    record.feedback[7].comfort = 2
    expect(compareExperiment(record).recommendation).toBe('keep_baseline')
    for (const report of record.feedback) report.comfort = 7
    expect(compareExperiment(record).recommendation).toBe('keep_baseline')
  })

  const exclusions: [Partial<ExperimentExposure>, ExperimentExclusion][] = [
    [{ execution: 'preview' }, 'preview_only'],
    [{ sourceState: 'withdrawn' }, 'source_withdrawn'],
    [{ bindingHash: 'f'.repeat(64) }, 'context_changed'],
    [{ routineHash: 'f'.repeat(64) }, 'context_changed'],
    [{ wakeHash: 'f'.repeat(64) }, 'context_changed'],
    [{ targetF: 72 }, 'wrong_target'],
    [{ matchedTargetMs: 3_600_000, qualifiedMs: 3_600_000 }, 'insufficient_coverage'],
    [{ occupiedMs: 3_600_000, qualifiedMs: 3_600_000 }, 'insufficient_coverage'],
    [{ matchedTargetMs: 26_000_000, occupiedMs: 26_000_000, qualifiedMs: 24_000_000 }, 'insufficient_coverage'],
    [{ manualChanges: 1 }, 'manual_change'],
    [{ unconfirmedCommands: 1 }, 'uncertain_command'],
    [{ safetyInterruptions: 1 }, 'safety_interruption'],
    [{ attributionAmbiguous: true }, 'ambiguous_sleeper'],
  ]
  it.each(exclusions)('excludes invalid evidence %j (%s)', (patch, expected) => {
    const record = completeExperiment()
    Object.assign(record.exposures[1], patch)
    const result = compareExperiment(record)
    expect(result.nights[1].usable).toBe(false)
    expect(result.nights[1].exclusions).toContain(expected)
    expect(result.recommendation).not.toBe('consider_variant')
  })

  it('excludes wake warming from a treatment observation', () => {
    const record = completeExperiment()
    record.exposures[1].wakeStartsAt = record.exposures[1].windowEnd - 1
    expect(compareExperiment(record).nights[1].exclusions).toContain('wake_overlap')
  })

  it('withholds the scored night if the preceding settling night was interrupted', () => {
    const record = completeExperiment()
    record.exposures[0].manualChanges = 1
    expect(compareExperiment(record).nights[1].exclusions).toContain('settling_unverified')
    expect(compareExperiment(record).pairedDifferences).toHaveLength(3)
    expect(compareExperiment(record).recommendation).toBe('inconclusive')
  })

  it('never loses a reported problem just because that night was excluded', () => {
    const record = completeExperiment()
    record.feedback[3].problem = true
    record.exposures[3].manualChanges = 1
    const result = compareExperiment(record)
    expect(result.nights[3].usable).toBe(false)
    expect(result.nights[3].problem).toBe(true)
    expect(result.recommendation).toBe('keep_baseline')
  })

  it('keeps unwanted adjustments and safety interruptions as adverse outcomes', () => {
    const record = completeExperiment()
    record.feedback[0].unwantedAdjustments = 1
    expect(compareExperiment(record).recommendation).toBe('keep_baseline')
    record.feedback[0].unwantedAdjustments = 0
    record.exposures[0].safetyInterruptions = 1
    expect(compareExperiment(record).recommendation).toBe('keep_baseline')
  })

  it('does not infer a full night or impute missing feedback', () => {
    const record = completeExperiment()
    record.feedback[1].confirmedFullNight = false
    expect(compareExperiment(record).nights[1].exclusions).toContain('partial_night')
    record.feedback.splice(1, 1)
    const night = compareExperiment(record).nights[1]
    expect(night.comfort).toBeNull()
    expect(night.exclusions).toContain('missing_feedback')
  })

  it('rejects duplicate, impossible, future and foreign night evidence', () => {
    const duplicate = completeExperiment()
    duplicate.exposures[1] = duplicate.exposures[0]
    expect(() => compareExperiment(duplicate)).toThrow()
    const impossible = completeExperiment()
    impossible.exposures[1].matchedTargetMs = impossible.exposures[1].observedMs + 1
    expect(() => compareExperiment(impossible)).toThrow()
    const future = completeExperiment()
    future.feedback[1].recordedAt = future.updatedAt + 1
    expect(() => compareExperiment(future)).toThrow()
    const foreign = completeExperiment()
    foreign.feedback[1].nightDate = '2026-12-20'
    expect(() => compareExperiment(foreign)).toThrow()
  })

  it('never uses an early or late retrospective rating as a scored outcome', () => {
    const record = completeExperiment()
    record.feedback[1].recordedAt = record.exposures[1].windowEnd - 1
    expect(compareExperiment(record).nights[1].exclusions).toContain('invalid_feedback_clock')
    record.feedback[1].recordedAt = record.exposures[1].windowEnd + 15 * 86_400_000
    record.updatedAt = Math.max(record.updatedAt, record.feedback[1].recordedAt)
    expect(compareExperiment(record).nights[1].exclusions).toContain('invalid_feedback_clock')
  })
})
