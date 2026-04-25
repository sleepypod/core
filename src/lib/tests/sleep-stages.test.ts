import { describe, it, expect } from 'vitest'
import {
  classifySleepStages,
  mergeIntoBlocks,
  calculateDistribution,
  calculateQualityScore,
  formatDurationHM,
  type SleepEpoch,
} from '../sleep-stages'

// Helper: create a vitals row
function vitalRow(minutesOffset: number, hr: number | null, hrv: number | null = null, br: number | null = null) {
  const baseTime = new Date('2026-03-18T23:00:00Z')
  return {
    timestamp: new Date(baseTime.getTime() + minutesOffset * 60_000),
    heartRate: hr,
    hrv,
    breathingRate: br,
  }
}

function movRow(minutesOffset: number, totalMovement: number) {
  const baseTime = new Date('2026-03-18T23:00:00Z')
  return {
    timestamp: new Date(baseTime.getTime() + minutesOffset * 60_000),
    totalMovement,
  }
}

describe('classifySleepStages', () => {
  it('returns empty array for empty vitals', () => {
    const result = classifySleepStages([], [])
    expect(result).toEqual([])
  })

  it('classifies high movement as wake', () => {
    const vitals = [vitalRow(0, 70, 40, 15)]
    const movement = [movRow(0, 500)]
    const result = classifySleepStages(vitals, movement)
    expect(result).toHaveLength(1)
    expect(result[0].stage).toBe('wake')
  })

  it('classifies low HR ratio as deep sleep', () => {
    // Use a varied window so the low-HR epoch stays within 2×stdDev of the window median.
    // Window at index 2: [80,65,63,75,72], median=72, stdDev≈6.3, 2×stdDev≈12.6
    // Deviation of 63 from 72 = 9 < 12.6 → passes outlier filter.
    // avg HR = 71, ratio = 63/71 = 0.887 < 0.92 → deep
    const vitals = [
      vitalRow(0, 80, 35, 15),
      vitalRow(5, 65, 40, 15),
      vitalRow(10, 63, 50, 14),
      vitalRow(15, 75, 38, 15),
      vitalRow(20, 72, 36, 15),
    ]
    const result = classifySleepStages(vitals, [], 1.0)
    expect(result[2].stage).toBe('deep')
  })

  it('classifies elevated HR + low HRV + low movement as REM', () => {
    // Use varied baseline so the elevated HR epoch stays within 2×stdDev of its window.
    // Window at index 4 (last): [65,68,78], median=68, stdDev≈5.6, 2×stdDev≈11.1
    // Deviation of 78 from 68 = 10 < 11.1 → passes outlier filter.
    // avg HR = 65.6, ratio = 78/65.6 = 1.19 > 0.95, HRV=18<25, movement=10<30 → REM
    // Index 4 is last so temporal smoothing cannot affect it.
    const vitals = [
      vitalRow(0, 55, 20, 14),
      vitalRow(5, 62, 20, 14),
      vitalRow(10, 65, 20, 14),
      vitalRow(15, 68, 20, 14),
      vitalRow(20, 78, 18, 16), // elevated HR + low HRV → REM
    ]
    const movement = [movRow(20, 10)] // low movement
    const result = classifySleepStages(vitals, movement, 1.0)
    expect(result[4].stage).toBe('rem')
  })

  it('applies temporal smoothing (A-B-A → A-A-A)', () => {
    // Create a sequence where middle epoch is different from neighbors
    const vitals = [
      vitalRow(0, 60, 40, 14), // light (ratio ~1.0, hrRatio between 0.92-0.95 → light)
      vitalRow(5, 60, 40, 14), // light
      vitalRow(10, 60, 40, 14), // light
    ]
    // Set movement to force middle to wake, but smoothing should fix it
    const movement = [
      movRow(0, 10),
      movRow(5, 300), // wake
      movRow(10, 10),
    ]
    const result = classifySleepStages(vitals, movement)
    // After smoothing: light-wake-light → light-light-light
    expect(result[0].stage).toBe(result[1].stage)
    expect(result[1].stage).toBe(result[2].stage)
  })

  it('preserves vitals data in epochs', () => {
    const vitals = [vitalRow(0, 72, 35, 16)]
    const result = classifySleepStages(vitals, [])
    expect(result[0].heartRate).toBe(72)
    expect(result[0].hrv).toBe(35)
    expect(result[0].breathingRate).toBe(16)
  })

  it('retains valid HR when outlier window collapses to a single sample (#327)', () => {
    // Regression: single-sample windows produce stdDev=0 which used to null out
    // any HR that differed from the median by even 1 bpm. The row below has
    // valid HR=68, and the windowed filter (±2) collapses to [null, null, 68,
    // null, null] → window=[68], stdDev=0. The filter must preserve the HR.
    const vitals = [
      vitalRow(0, null, null, null),
      vitalRow(5, null, null, null),
      vitalRow(10, 68, 40, 14),
      vitalRow(15, null, null, null),
      vitalRow(20, null, null, null),
    ]
    const result = classifySleepStages(vitals, [], 1.0)
    expect(result[2].heartRate).toBe(68)
  })

  it('does not over-classify REM when movement data is missing (#327)', () => {
    // Regression: both REM branches previously used `movement === null ||
    // movement < threshold`, so a null movement always satisfied the
    // low-movement clause and every elevated-HR epoch became REM. Without any
    // movement evidence the classifier must fall through to 'light'.
    // hrRatio stays ≥ 0.95 (flat HR=70) and HRV=20<25 so the REM branches would
    // fire if movement-null still counted as low-movement.
    const vitals = [
      vitalRow(0, 70, 20, 14),
      vitalRow(5, 70, 20, 14),
      vitalRow(10, 70, 20, 14),
      vitalRow(15, 70, 20, 14),
      vitalRow(20, 70, 20, 14),
    ]
    const result = classifySleepStages(vitals, [], 1.0)
    for (const epoch of result) {
      expect(epoch.stage).not.toBe('rem')
    }
  })

  it('still classifies REM when movement is explicitly low (#327)', () => {
    // Guard: the fix above must not silently break the normal REM path.
    // Varied baseline so the elevated epoch passes the outlier filter.
    const vitals = [
      vitalRow(0, 55, 20, 14),
      vitalRow(5, 62, 20, 14),
      vitalRow(10, 65, 20, 14),
      vitalRow(15, 68, 20, 14),
      vitalRow(20, 78, 18, 16),
    ]
    const movement = [
      movRow(0, 10),
      movRow(5, 10),
      movRow(10, 10),
      movRow(15, 10),
      movRow(20, 10),
    ]
    const result = classifySleepStages(vitals, movement, 1.0)
    expect(result[4].stage).toBe('rem')
  })
})

describe('mergeIntoBlocks', () => {
  it('returns empty array for empty epochs', () => {
    expect(mergeIntoBlocks([])).toEqual([])
  })

  it('merges consecutive same-stage epochs', () => {
    const epochs: SleepEpoch[] = [
      { start: 0, duration: 300_000, stage: 'light', heartRate: 60, hrv: 30, breathingRate: 14, movement: null },
      { start: 300_000, duration: 300_000, stage: 'light', heartRate: 61, hrv: 31, breathingRate: 14, movement: null },
      { start: 600_000, duration: 300_000, stage: 'deep', heartRate: 55, hrv: 40, breathingRate: 12, movement: null },
    ]
    const blocks = mergeIntoBlocks(epochs)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].stage).toBe('light')
    expect(blocks[0].end).toBe(600_000)
    expect(blocks[1].stage).toBe('deep')
  })

  it('keeps single epoch as single block', () => {
    const epochs: SleepEpoch[] = [
      { start: 0, duration: 300_000, stage: 'rem', heartRate: 65, hrv: 20, breathingRate: 15, movement: null },
    ]
    const blocks = mergeIntoBlocks(epochs)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toEqual({ start: 0, end: 300_000, stage: 'rem' })
  })
})

describe('calculateDistribution', () => {
  it('returns zeros for empty epochs', () => {
    expect(calculateDistribution([])).toEqual({ wake: 0, light: 0, deep: 0, rem: 0 })
  })

  it('calculates correct percentages', () => {
    const epochs: SleepEpoch[] = [
      { start: 0, duration: 100, stage: 'deep', heartRate: null, hrv: null, breathingRate: null, movement: null },
      { start: 100, duration: 100, stage: 'light', heartRate: null, hrv: null, breathingRate: null, movement: null },
      { start: 200, duration: 100, stage: 'rem', heartRate: null, hrv: null, breathingRate: null, movement: null },
      { start: 300, duration: 100, stage: 'wake', heartRate: null, hrv: null, breathingRate: null, movement: null },
    ]
    const dist = calculateDistribution(epochs)
    expect(dist.deep).toBe(25)
    expect(dist.light).toBe(25)
    expect(dist.rem).toBe(25)
    expect(dist.wake).toBe(25)
  })
})

describe('calculateQualityScore', () => {
  it('returns high score for ideal distribution', () => {
    const score = calculateQualityScore({ deep: 20, light: 45, rem: 25, wake: 3 })
    expect(score).toBeGreaterThanOrEqual(90)
  })

  it('penalizes low deep sleep', () => {
    const good = calculateQualityScore({ deep: 20, light: 50, rem: 25, wake: 5 })
    const bad = calculateQualityScore({ deep: 5, light: 65, rem: 25, wake: 5 })
    expect(bad).toBeLessThan(good)
  })

  it('penalizes high wake percentage', () => {
    const good = calculateQualityScore({ deep: 20, light: 45, rem: 25, wake: 3 })
    const bad = calculateQualityScore({ deep: 20, light: 35, rem: 25, wake: 20 })
    expect(bad).toBeLessThan(good)
  })

  it('caps at 50 for low calibration quality', () => {
    const score = calculateQualityScore({ deep: 20, light: 45, rem: 25, wake: 3 }, 0.2)
    expect(score).toBeLessThanOrEqual(50)
  })
})

describe('formatDurationHM', () => {
  it('formats hours and minutes', () => {
    expect(formatDurationHM(7_200_000)).toBe('2h') // 2 hours
    expect(formatDurationHM(5_400_000)).toBe('1h 30m') // 1.5 hours
    expect(formatDurationHM(1_800_000)).toBe('30m') // 30 min
    expect(formatDurationHM(0)).toBe('0m')
  })
})
