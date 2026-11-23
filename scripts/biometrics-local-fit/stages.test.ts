// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { datasetSnapshotSchema } from '@/src/biometrics/backtest/contracts'
import { previewReferenceImport } from '@/src/biometrics/references/normalize'
import { referenceBreathing, referenceStages, remLightSeparation } from './stages'

const T0 = 1791673200000, MINUTE = 60000
const values = (rates: number[], offsetMinutes = 0) => rates.map((value, index) => ({ timestampMs: T0 + (offsetMinutes + index) * MINUTE, value }))
const stages = [{ startMs: T0, endMs: T0 + 5 * MINUTE, stage: 'rem' }, { startMs: T0 + 5 * MINUTE, endMs: T0 + 10 * MINUTE, stage: 'light' }]

describe('REM-light breathing separation', () => {
  it('averages night differences and pools the spread around each night\'s stage means', () => {
    // Night 1: REM 15 ± 1, light 13 ± 1. Night 2 runs 4 higher overall with the same shape.
    const night = (shift: number) => ({ stages, values: values([16, 14, 16, 14, 15, 14, 12, 14, 12, 13].map(value => value + shift)) })
    const result = remLightSeparation([night(0), night(4)])
    // Squares around each stage mean sum to 4, so each night adds 8 over 8 degrees of freedom.
    expect(result).toMatchObject({ status: 'scored', nights: 2, remValues: 10, lightValues: 10, meanDifference: 2 })
    expect(result.pooledSd).toBeCloseTo(Math.sqrt(16 / 16))
    expect(result.standardized).toBeCloseTo(2)
  })

  it('leaves out nights without enough values in both stages and reads unscored, never zero', () => {
    expect(remLightSeparation([{ stages, values: values([15, 15, 15, 15]) }])).toEqual({ status: 'no_paired_reference', nights: 0, remValues: 0, lightValues: 0,
      meanDifference: null, pooledSd: null, standardized: null })
    expect(remLightSeparation([{ stages: [], values: values([15, 14, 15, 14, 15, 14, 15, 14, 15, 14]) }]).status).toBe('no_paired_reference')
    expect(remLightSeparation([]).status).toBe('no_paired_reference')
    // Identical stage values: a difference but no spread to scale it by.
    expect(remLightSeparation([{ stages, values: values([15, 15, 15, 15, 15, 14, 14, 14, 14, 14]) }])).toMatchObject({ status: 'scored', meanDifference: 1, pooledSd: 0, standardized: null })
  })

  it('skips times where overlapping imports disagree on the stage', () => {
    const overlapping = [{ startMs: T0, endMs: T0 + 6 * MINUTE, stage: 'rem' }, { startMs: T0, endMs: T0 + MINUTE, stage: 'deep' },
      { startMs: T0 + 6 * MINUTE, endMs: T0 + 11 * MINUTE, stage: 'light' }]
    const result = remLightSeparation([{ stages: overlapping, values: values([30, 16, 14, 16, 14, 15, 14, 12, 14, 12, 13]) }])
    expect(result).toMatchObject({ remValues: 5, lightValues: 5, meanDifference: 2 })
  })
})

describe('reference stages and breathing', () => {
  it('reads scorable Watch stage intervals and breathing values inside the night only', () => {
    const measurements = previewReferenceImport({ side: 'left', subjectId: 'A', source: 'watch', rows: [
      { recordKey: 'rem', metric: 'sleep_stages', value: 'rem', unit: 'stage', startMs: T0, endMs: T0 + 5 * MINUTE },
      { recordKey: 'late', metric: 'sleep_stages', value: 'light', unit: 'stage', startMs: T0 + 20 * MINUTE, endMs: T0 + 25 * MINUTE },
      { recordKey: 'br', metric: 'breathing_rate', value: 15, unit: 'breaths/min', timestampMs: T0 + MINUTE },
      { recordKey: 'br-late', metric: 'breathing_rate', value: 16, unit: 'breaths/min', timestampMs: T0 + 20 * MINUTE },
      { recordKey: 'hr', metric: 'heart_rate', value: 60, unit: 'bpm', timestampMs: T0 + MINUTE },
    ] }).measurements
    const snapshot = datasetSnapshotSchema.parse({ version: 'processed-dataset-v1', side: 'left', subjectId: 'A', sessions: [], processingRuns: [],
      references: [{ importId: 'watch', revision: 1, contentHash: 'x', source: 'watch', timePolicy: {}, measurements }] })
    expect(referenceStages(snapshot, T0, T0 + 10 * MINUTE)).toEqual([{ startMs: T0, endMs: T0 + 5 * MINUTE, stage: 'rem' }])
    expect(referenceBreathing(snapshot, T0, T0 + 10 * MINUTE)).toEqual([{ timestampMs: T0 + MINUTE, value: 15 }])
  })
})
