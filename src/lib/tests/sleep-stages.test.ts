import { describe, it, expect } from 'vitest'
import {
  changedSegments,
  classifyNights,
  classifySleepStages,
  mergeIntoBlocks,
  mergeRunStats,
  runStageClassifier,
  stageDurations,
  summarizeRuns,
  calculateDistribution,
  calculateQualityScore,
  formatDurationHM,
  piezoCalibrationQuality,
  scoreAgainstReference,
  type SleepEpoch,
  type SleepStage,
  type StageRunStats,
} from '../sleep-stages'
import { DEFAULT_STAGE_RULESET, MOVEMENT_ONLY_STAGE_RULESET, type StageRuleset } from '../sleep-stage-rules'

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
    // Regression: when the ±2 window has only one valid HR (its own value at i),
    // window=[68], median=mean=68 and stdDev=0. The pre-fix condition
    // `Math.abs(heartRate - median) > 2 * 0` evaluated to false here because
    // heartRate==median, but in any uniform-window scenario it would silently
    // null an out-of-window value. The post-fix `stdDev > 0 &&` short-circuit
    // makes the single-sample-window path explicit and safe. Verify the HR at
    // index 2 is preserved when it's the only valid sample in its window.
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

  it('penalizes excessive deep sleep (>30%)', () => {
    const ideal = calculateQualityScore({ deep: 20, light: 45, rem: 25, wake: 3 })
    const tooMuchDeep = calculateQualityScore({ deep: 50, light: 18, rem: 25, wake: 3 })
    expect(tooMuchDeep).toBeLessThan(ideal)
  })

  it('penalizes low REM (<20%)', () => {
    const ideal = calculateQualityScore({ deep: 20, light: 45, rem: 25, wake: 3 })
    const lowRem = calculateQualityScore({ deep: 20, light: 65, rem: 5, wake: 3 })
    expect(lowRem).toBeLessThan(ideal)
  })

  it('penalizes excessive REM (>35%)', () => {
    const ideal = calculateQualityScore({ deep: 20, light: 45, rem: 25, wake: 3 })
    const tooMuchRem = calculateQualityScore({ deep: 20, light: 25, rem: 45, wake: 3 })
    expect(tooMuchRem).toBeLessThan(ideal)
  })
})

describe('calculateDistribution edge cases', () => {
  it('returns zeros for an empty epoch list', () => {
    expect(calculateDistribution([])).toEqual({ wake: 0, light: 0, deep: 0, rem: 0 })
  })

  it('returns zeros when every epoch has zero duration', () => {
    const zeros = { heartRate: null, hrv: null, breathingRate: null, movement: null }
    expect(calculateDistribution([
      { stage: 'wake', duration: 0, start: 0, ...zeros },
      { stage: 'deep', duration: 0, start: 0, ...zeros },
    ])).toEqual({ wake: 0, light: 0, deep: 0, rem: 0 })
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

// ─────────────────────────────────────────────────────────────────────────────
// Mutation-killing tests (issue #543)
// Each block pins behaviour against a specific class of surviving mutants
// surfaced by Stryker. Boundary values are chosen exactly to make
// `<` vs `<=`, `>` vs `>=`, `+` vs `-`, and `||` vs `&&` observable.
// ─────────────────────────────────────────────────────────────────────────────

describe('filterOutliers — hard limits (heart rate)', () => {
  // 5 uniform samples keep stdDev=0 so the windowed filter is skipped
  // (`stdDev > 0` guard) and only the hard-limit branch is exercised.
  const fiveOf = (hr: number) => [
    vitalRow(0, hr), vitalRow(5, hr), vitalRow(10, hr), vitalRow(15, hr), vitalRow(20, hr),
  ]

  it('keeps heart rate at lower boundary 45', () => {
    expect(classifySleepStages(fiveOf(45), [], 1.0)[0].heartRate).toBe(45)
  })

  it('nulls heart rate one below lower boundary (44)', () => {
    expect(classifySleepStages(fiveOf(44), [], 1.0)[0].heartRate).toBeNull()
  })

  it('keeps heart rate at upper boundary 130', () => {
    expect(classifySleepStages(fiveOf(130), [], 1.0)[0].heartRate).toBe(130)
  })

  it('nulls heart rate one above upper boundary (131)', () => {
    expect(classifySleepStages(fiveOf(131), [], 1.0)[0].heartRate).toBeNull()
  })

  it('nulls a low-only outlier (kills || → && on the OR-range)', () => {
    // HR=20 satisfies <45 but not >130. With `||`→`&&` the row would be kept.
    expect(classifySleepStages([vitalRow(0, 20)], [], 1.0)[0].heartRate).toBeNull()
  })

  it('nulls a high-only outlier (kills || → && on the OR-range)', () => {
    expect(classifySleepStages([vitalRow(0, 200)], [], 1.0)[0].heartRate).toBeNull()
  })
})

describe('filterOutliers — hard limits (HRV)', () => {
  it('keeps HRV at lower boundary 1', () => {
    expect(classifySleepStages([vitalRow(0, 60, 1)], [], 1.0)[0].hrv).toBe(1)
  })

  it('nulls HRV at 0 (just below lower boundary)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 0)], [], 1.0)[0].hrv).toBeNull()
  })

  it('keeps HRV at upper boundary 300', () => {
    expect(classifySleepStages([vitalRow(0, 60, 300)], [], 1.0)[0].hrv).toBe(300)
  })

  it('nulls HRV at 301 (just above upper boundary)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 301)], [], 1.0)[0].hrv).toBeNull()
  })

  it('nulls a low-only HRV (kills || → && on the OR-range)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 0.5)], [], 1.0)[0].hrv).toBeNull()
  })

  it('nulls a high-only HRV (kills || → && on the OR-range)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 400)], [], 1.0)[0].hrv).toBeNull()
  })
})

describe('filterOutliers — hard limits (breathing rate)', () => {
  it('keeps breathingRate at lower boundary 8', () => {
    expect(classifySleepStages([vitalRow(0, 60, 40, 8)], [], 1.0)[0].breathingRate).toBe(8)
  })

  it('nulls breathingRate at 7 (just below lower boundary)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 40, 7)], [], 1.0)[0].breathingRate).toBeNull()
  })

  it('keeps breathingRate at upper boundary 25', () => {
    expect(classifySleepStages([vitalRow(0, 60, 40, 25)], [], 1.0)[0].breathingRate).toBe(25)
  })

  it('nulls breathingRate at 26 (just above upper boundary)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 40, 26)], [], 1.0)[0].breathingRate).toBeNull()
  })

  it('nulls a low-only breathingRate (kills || → && on the OR-range)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 40, 5)], [], 1.0)[0].breathingRate).toBeNull()
  })

  it('nulls a high-only breathingRate (kills || → && on the OR-range)', () => {
    expect(classifySleepStages([vitalRow(0, 60, 40, 30)], [], 1.0)[0].breathingRate).toBeNull()
  })
})

describe('filterOutliers — windowed median filter', () => {
  it('nulls an HR spike that deviates >2× stdDev from the window median', () => {
    // window=[60,60,100,60,60]: median=60, stdDev≈16, 2×stdDev≈32, |100-60|=40 → null.
    // Kills BlockStatement{}, ConditionalExpression false on windowHRs.length>0
    // and stdDev>0, ArrayDeclaration [], ArithmeticOperator on the reducers.
    const v = [vitalRow(0, 60), vitalRow(5, 60), vitalRow(10, 100), vitalRow(15, 60), vitalRow(20, 60)]
    expect(classifySleepStages(v, [], 1.0)[2].heartRate).toBeNull()
  })

  it('keeps surrounding HRs that match their own window median', () => {
    const v = [vitalRow(0, 60), vitalRow(5, 60), vitalRow(10, 100), vitalRow(15, 60), vitalRow(20, 60)]
    const r = classifySleepStages(v, [], 1.0)
    expect(r[0].heartRate).toBe(60)
    expect(r[1].heartRate).toBe(60)
    expect(r[3].heartRate).toBe(60)
    expect(r[4].heartRate).toBe(60)
  })

  it('uses only the two neighboring readings on each side', () => {
    const vitals = [130, 130, 60, 60, 100, 60, 60, 130, 130]
      .map((heartRate, index) => vitalRow(index * 5, heartRate))

    expect(classifySleepStages(vitals, [], 1.0)[4].heartRate).toBeNull()
  })

  it('includes the valid lower HR boundary in the median window', () => {
    const vitals = [45, 45, 46, 80, 80]
      .map((heartRate, index) => vitalRow(index * 5, heartRate))

    expect(classifySleepStages(vitals, [], 1.0)[2].heartRate).toBe(46)
  })

  it('includes the valid upper HR boundary in the median window', () => {
    const vitals = [60, 60, 46, 130, 130]
      .map((heartRate, index) => vitalRow(index * 5, heartRate))

    expect(classifySleepStages(vitals, [], 1.0)[2].heartRate).toBe(46)
  })

  it('excludes above-range neighbors from the median window', () => {
    const vitals = [60, 131, 131]
      .map((heartRate, index) => vitalRow(index * 5, heartRate))

    expect(classifySleepStages(vitals, [], 1.0)[0].heartRate).toBe(60)
  })

  it('excludes below-range neighbors from the median window', () => {
    const vitals = [1, 80, 100, 80]
      .map((heartRate, index) => vitalRow(index * 5, heartRate))

    expect(classifySleepStages(vitals, [], 1.0)[2].heartRate).toBeNull()
  })
})

describe('classifySleepStages — average HR selection', () => {
  it('excludes null readings from the average HR denominator', () => {
    const result = classifySleepStages([
      vitalRow(0, 50),
      vitalRow(5, null),
      vitalRow(10, 70),
    ], [], 1.0)

    expect(result[0].stage).toBe('deep')
  })

  it('uses the observed average whenever at least one valid HR exists', () => {
    const result = classifySleepStages([
      vitalRow(0, 58),
      vitalRow(5, 82),
    ], [], 1.0)

    expect(result[0].stage).toBe('deep')
  })
})

describe('classifySleepStages — sort and duration', () => {
  it('does not mutate the caller-supplied vitalsData order', () => {
    // ArrayDeclaration `[...vitalsData]` → `vitalsData` would sort the input in place.
    const v = [vitalRow(20, 60), vitalRow(0, 60), vitalRow(10, 60)]
    const before = v.map(r => r.timestamp.getTime())
    classifySleepStages(v, [], 1.0)
    expect(v.map(r => r.timestamp.getTime())).toEqual(before)
  })

  it('sorts epochs in ascending timestamp order regardless of input order', () => {
    // ArithmeticOperator on the sort comparator (a-b → a+b) would break ordering.
    const v = [vitalRow(20, 60), vitalRow(0, 60), vitalRow(10, 60)]
    const r = classifySleepStages(v, [], 1.0)
    expect(r[0].start).toBeLessThan(r[1].start)
    expect(r[1].start).toBeLessThan(r[2].start)
  })

  it('uses gap-to-next-sample as duration for non-last epochs', () => {
    // 5-min gap → duration=300_000. Math.min vs Math.max diverge once the
    // ternary picks `nextTs - ts` (300k) over the 600k cap.
    expect(classifySleepStages([vitalRow(0, 60), vitalRow(5, 60)], [], 1.0)[0].duration).toBe(300_000)
  })

  it('caps non-last-epoch duration at 10 minutes for long gaps', () => {
    // 30-min gap → Math.min(1_800_000, 600_000) = 600_000. ConditionalExpression
    // `false` on the `i < length-1` ternary would substitute ts+5min → 300_000.
    expect(classifySleepStages([vitalRow(0, 60), vitalRow(30, 60)], [], 1.0)[0].duration).toBe(600_000)
  })

  it('defaults last-epoch duration to exactly 5 minutes', () => {
    // ArithmeticOperator `ts + 300_000` → `ts - 300_000` would yield -300_000.
    expect(classifySleepStages([vitalRow(0, 60)], [], 1.0)[0].duration).toBe(300_000)
  })
})

describe('classifySleepStages — phase 2 smoothing only fires when neighbors match', () => {
  it('does NOT smooth a middle epoch when its neighbors disagree (A-B-C stays A-B-C)', () => {
    // ConditionalExpression `true` on the smoothing check would rewrite
    // epoch[1] to match epoch[0] unconditionally. Use uniform HR (so the
    // windowed outlier filter is a no-op via stdDev=0) and drive the stage
    // pattern through movement + HRV only.
    // Phase 1: [light (mov=10), rem (hrv=20+mov=20), wake (mov=300)].
    const v = [
      vitalRow(0, 70),
      vitalRow(5, 70, 20, 14),
      vitalRow(10, 70),
    ]
    const m = [movRow(0, 10), movRow(5, 20), movRow(10, 300)]
    expect(classifySleepStages(v, m, 1.0)[1].stage).toBe('rem')
  })
})

describe('classifySleepStages — phase 3 transition constraints', () => {
  it('does not rewrite a wake → wake transition', () => {
    const vitals = [vitalRow(0, 70), vitalRow(5, 70)]
    const movement = [movRow(0, 300), movRow(5, 300)]

    expect(classifySleepStages(vitals, movement, 1.0).map(epoch => epoch.stage)).toEqual([
      'wake',
      'wake',
    ])
  })

  it('does not rewrite a rem → rem transition', () => {
    const vitals = [vitalRow(0, 70, 20), vitalRow(5, 70, 20)]
    const movement = [movRow(0, 10), movRow(5, 10)]

    expect(classifySleepStages(vitals, movement, 1.0).map(epoch => epoch.stage)).toEqual([
      'rem',
      'rem',
    ])
  })

  it('inserts light between wake → deep', () => {
    const v = [vitalRow(0, 70), vitalRow(5, 50)]
    const m = [movRow(0, 300), movRow(5, 0)]
    const r = classifySleepStages(v, m, 1.0)
    expect(r[0].stage).toBe('wake')
    expect(r[1].stage).toBe('light')
  })

  it('inserts light between deep → wake', () => {
    const v = [vitalRow(0, 50), vitalRow(5, 70)]
    const m = [movRow(0, 0), movRow(5, 300)]
    const r = classifySleepStages(v, m, 1.0)
    expect(r[0].stage).toBe('deep')
    expect(r[1].stage).toBe('light')
  })

  it('inserts light between deep → rem', () => {
    const v = [vitalRow(0, 50), vitalRow(5, 70, 20, 14)]
    const m = [movRow(0, 0), movRow(5, 10)]
    const r = classifySleepStages(v, m, 1.0)
    expect(r[0].stage).toBe('deep')
    expect(r[1].stage).toBe('light')
  })

  it('inserts light between rem → deep', () => {
    const v = [vitalRow(0, 70, 20, 14), vitalRow(5, 50)]
    const m = [movRow(0, 10), movRow(5, 0)]
    const r = classifySleepStages(v, m, 1.0)
    expect(r[0].stage).toBe('rem')
    expect(r[1].stage).toBe('light')
  })

  it('does NOT rewrite a light → deep transition (no rule fires)', () => {
    // ConditionalExpression `true` on lines 197/209 (`wake→deep` and `rem→deep`)
    // would force epoch[1] to 'light' here. Original keeps it 'deep'.
    // [0] HR=65 hrv=null mov=null → light (ratio≈1.08, no REM signals).
    // [1] HR=55 hrv=null mov=null → deep (ratio≈0.92 → 0.917<0.92).
    const v = [vitalRow(0, 65), vitalRow(5, 55)]
    const r = classifySleepStages(v, [], 1.0)
    expect(r[0].stage).toBe('light')
    expect(r[1].stage).toBe('deep')
  })

  it('does NOT rewrite a light → wake transition (no rule fires)', () => {
    // ConditionalExpression `true` on line 201 (`deep→wake`) would force [1] to 'light'.
    const v = [vitalRow(0, 70), vitalRow(5, 70)]
    const m = [movRow(0, 10), movRow(5, 300)]
    const r = classifySleepStages(v, m, 1.0)
    expect(r[0].stage).toBe('light')
    expect(r[1].stage).toBe('wake')
  })

  it('does NOT rewrite a light → rem transition (no rule fires)', () => {
    // ConditionalExpression `true` on line 205 (`deep→rem`) would force [1] to 'light'.
    const v = [vitalRow(0, 70), vitalRow(5, 70, 20, 14)]
    const m = [movRow(0, 10), movRow(5, 10)]
    const r = classifySleepStages(v, m, 1.0)
    expect(r[0].stage).toBe('light')
    expect(r[1].stage).toBe('rem')
  })
})

describe('classifyEpoch — calibration threshold (strict <)', () => {
  // window[0]=[50,50,55] for HR=50 at i=0: median=50, |50-50|=0 → kept.
  // avgHR=59 → ratio=50/59≈0.847 < 0.92 → 'deep' on the high-cal path.
  // Low-cal path with movement=null returns 'light' unconditionally.
  const vitals = [
    vitalRow(0, 50), vitalRow(5, 50), vitalRow(10, 55), vitalRow(15, 70), vitalRow(20, 70),
  ]

  it('uses high-cal classification at calibrationQuality === 0.3 (strict <)', () => {
    expect(classifySleepStages(vitals, [], 0.3)[0].stage).toBe('deep')
  })

  it('uses low-cal classification just below 0.3', () => {
    expect(classifySleepStages(vitals, [], 0.29)[0].stage).toBe('light')
  })
})

describe('classifyEpoch — low-cal movement thresholds', () => {
  // Use cal=0.1 to stay deep inside the low-cal branch.
  // HR is uniform so the windowed outlier filter is a no-op.
  const uniformHR = (mov: number) => ({
    v: [vitalRow(0, 70)],
    m: [movRow(0, mov)],
  })

  it('classifies movement > 200 as wake under low-cal (line 227)', () => {
    const { v, m } = uniformHR(300)
    expect(classifySleepStages(v, m, 0.1)[0].stage).toBe('wake')
  })

  it('does NOT classify movement === 200 as wake under low-cal (strict >)', () => {
    // EqualityOperator `> 200` → `>= 200` on line 227 would yield 'wake' here.
    // Line 228 catches movement>100 and returns 'light' instead.
    const { v, m } = uniformHR(200)
    expect(classifySleepStages(v, m, 0.1)[0].stage).toBe('light')
  })

  it('returns light when movement is null under low-cal (kills line-227 true)', () => {
    // ConditionalExpression `true` on line 227 would return 'wake' here.
    const r = classifySleepStages([vitalRow(0, 70)], [], 0.1)
    expect(r[0].stage).toBe('light')
  })
})

describe('classifyEpoch — high-cal REM fallback (line 248)', () => {
  // Uniform HR=70 → ratio=1.0 across the board (no outlier filtering).
  // The REM fallback fires when movement<50 AND hrv<40 (and the first
  // REM check on line 244 misses).

  it('classifies hrv=30, movement=10 as REM via the fallback branch', () => {
    // Line 244 misses (hrv=30 is not <25). Line 248 must catch it.
    // ConditionalExpression `false` on line 248 would default to 'light'.
    const r = classifySleepStages([vitalRow(0, 70, 30, 14)], [movRow(0, 10)], 1.0)
    expect(r[0].stage).toBe('rem')
  })

  it('does NOT classify hrv=40 as REM (strict <)', () => {
    // EqualityOperator `hrv < 40` → `hrv <= 40` would yield 'rem'.
    const r = classifySleepStages([vitalRow(0, 70, 40, 14)], [movRow(0, 10)], 1.0)
    expect(r[0].stage).toBe('light')
  })

  it('classifies hrv=39 as REM (just below the 40 boundary)', () => {
    // EqualityOperator `hrv < 40` → `hrv >= 40` would yield 'light'.
    const r = classifySleepStages([vitalRow(0, 70, 39, 14)], [movRow(0, 10)], 1.0)
    expect(r[0].stage).toBe('rem')
  })

  it('does NOT classify movement=50 as REM (strict <)', () => {
    // EqualityOperator `movement < 50` → `movement <= 50` would yield 'rem'.
    const r = classifySleepStages([vitalRow(0, 70, 39, 14)], [movRow(0, 50)], 1.0)
    expect(r[0].stage).toBe('light')
  })

  it('classifies movement=49 as REM (just below the 50 boundary)', () => {
    // EqualityOperator `movement < 50` → `movement >= 50` would yield 'light'.
    const r = classifySleepStages([vitalRow(0, 70, 39, 14)], [movRow(0, 49)], 1.0)
    expect(r[0].stage).toBe('rem')
  })

  it('falls through to light when REM signals are absent (kills line-248 true)', () => {
    // ConditionalExpression `true` on line 248 would short-circuit to REM
    // regardless of hrv/movement values.
    const r = classifySleepStages([vitalRow(0, 70)], [], 1.0)
    expect(r[0].stage).toBe('light')
  })
})

describe('classifyEpoch — high-cal wake fallback at ratio≥0.95 (line 252)', () => {
  // HR=70 uniform → ratio=1.0. HRV null so lines 244 and 248 don't fire.

  it('classifies movement=150 as wake via the line-252 fallback', () => {
    // ConditionalExpression `false` on line 252 would default to 'light'.
    // movement=150 sits in (100, 200] so line 233 (`>200`) does not fire first.
    const r = classifySleepStages([vitalRow(0, 70)], [movRow(0, 150)], 1.0)
    expect(r[0].stage).toBe('wake')
  })

  it('does NOT classify movement=100 as wake (strict >)', () => {
    // EqualityOperator `> 100` → `>= 100` on line 252 would yield 'wake'.
    const r = classifySleepStages([vitalRow(0, 70)], [movRow(0, 100)], 1.0)
    expect(r[0].stage).toBe('light')
  })
})

describe('classifyEpoch — high-cal wake threshold at movement > 200', () => {
  // Choose HR ratio in (0.92, 0.95) so the line-252 wake fallback (which only
  // fires for ratio≥0.95) cannot mask the line-233 mutant.
  const calmIshHR = [
    vitalRow(0, 63), vitalRow(5, 65), vitalRow(10, 70), vitalRow(15, 70), vitalRow(20, 70),
  ]

  it('does NOT flag wake at movement === 200 (strict >)', () => {
    const m = [movRow(0, 200)]
    expect(classifySleepStages(calmIshHR, m, 1.0)[0].stage).not.toBe('wake')
  })

  it('flags wake at movement > 200 (line-233 path active)', () => {
    const m = [movRow(0, 250)]
    expect(classifySleepStages(calmIshHR, m, 1.0)[0].stage).toBe('wake')
  })
})

describe('classifyEpoch — exact HR-ratio boundaries', () => {
  it('does not classify an exact 0.92 HR ratio as deep', () => {
    const vitals = [69, 69, 69, 84, 84]
      .map((heartRate, index) => vitalRow(index * 5, heartRate))

    expect(classifySleepStages(vitals, [], 1.0)[0].stage).toBe('light')
  })

  it('enters the elevated-HR branch at an exact 0.95 ratio', () => {
    const vitals = [76, 76, 76, 86, 86]
      .map((heartRate, index) => vitalRow(index * 5, heartRate, index === 0 ? 20 : null))

    expect(classifySleepStages(vitals, [movRow(0, 10)], 1.0)[0].stage).toBe('rem')
  })

  it('does not classify moderate movement as REM through the narrow first branch', () => {
    const result = classifySleepStages(
      [vitalRow(0, 70, 20, 14)],
      [movRow(0, 100)],
      1.0,
    )
    expect(result[0].stage).toBe('light')
  })

  it('does not infer deep sleep from a missing heart rate', () => {
    expect(classifySleepStages([vitalRow(0, null)], [], 1.0)[0].stage).toBe('light')
  })
})

describe('mergeIntoBlocks — boundary arithmetic', () => {
  it('computes block end as start + duration on stage change', () => {
    // ArithmeticOperator `+` → `-` at line 281: end would collapse to 0.
    const epochs: SleepEpoch[] = [
      { start: 0, duration: 300_000, stage: 'light', heartRate: 60, hrv: 30, breathingRate: 14, movement: null },
      { start: 300_000, duration: 300_000, stage: 'deep', heartRate: 55, hrv: 40, breathingRate: 12, movement: null },
    ]
    const blocks = mergeIntoBlocks(epochs)
    expect(blocks).toHaveLength(2)
    expect(blocks[1].start).toBe(300_000)
    expect(blocks[1].end).toBe(600_000)
  })
})

describe('calculateDistribution — divide-by-zero guard', () => {
  it('returns zeros when all epoch durations sum to zero', () => {
    // ConditionalExpression `totalDuration === 0` → `false` would divide by 0,
    // producing NaN percentages.
    const epochs: SleepEpoch[] = [
      { start: 0, duration: 0, stage: 'deep', heartRate: null, hrv: null, breathingRate: null, movement: null },
      { start: 0, duration: 0, stage: 'light', heartRate: null, hrv: null, breathingRate: null, movement: null },
    ]
    expect(calculateDistribution(epochs)).toEqual({ wake: 0, light: 0, deep: 0, rem: 0 })
  })
})

describe('calculateQualityScore — exact penalty arithmetic', () => {
  it('returns exactly 100 for an ideal distribution (no penalty triggered)', () => {
    expect(calculateQualityScore({ deep: 20, light: 50, rem: 25, wake: 5 })).toBe(100)
  })

  it('subtracts 2 per percentage point below the 15% deep target', () => {
    // deep=10 → penalty (15-10)*2 = 10 → score 90.
    expect(calculateQualityScore({ deep: 10, light: 60, rem: 25, wake: 5 })).toBe(90)
  })

  it('does not let a below-threshold wake percentage cancel another penalty', () => {
    expect(calculateQualityScore({ deep: 10, light: 65, rem: 25, wake: 0 })).toBe(90)
  })

  it('subtracts 1.5 per percentage point above the 30% deep target', () => {
    // deep=40 → penalty (40-30)*1.5 = 15 → score 85.
    expect(calculateQualityScore({ deep: 40, light: 30, rem: 25, wake: 5 })).toBe(85)
  })

  it('subtracts 1.5 per percentage point below the 20% REM target', () => {
    // rem=10 → penalty (20-10)*1.5 = 15 → score 85.
    expect(calculateQualityScore({ deep: 20, light: 65, rem: 10, wake: 5 })).toBe(85)
  })

  it('subtracts 1 per percentage point above the 35% REM target', () => {
    // rem=45 → penalty (45-35)*1 = 10 → score 90.
    expect(calculateQualityScore({ deep: 20, light: 30, rem: 45, wake: 5 })).toBe(90)
  })

  it('subtracts 2 per percentage point above the 5% wake target', () => {
    // wake=15 → penalty (15-5)*2 = 20 → score 80.
    expect(calculateQualityScore({ deep: 20, light: 40, rem: 25, wake: 15 })).toBe(80)
  })

  it('still penalizes deep one below the 15% boundary', () => {
    // deep=14 → penalty (15-14)*2 = 2 → score 98.
    expect(calculateQualityScore({ deep: 14, light: 56, rem: 25, wake: 5 })).toBe(98)
  })

  it('does not penalize at the boundaries (deep=30, rem=20, rem=35, wake=5)', () => {
    expect(calculateQualityScore({ deep: 30, light: 40, rem: 25, wake: 5 })).toBe(100)
    expect(calculateQualityScore({ deep: 20, light: 55, rem: 20, wake: 5 })).toBe(100)
    expect(calculateQualityScore({ deep: 20, light: 40, rem: 35, wake: 5 })).toBe(100)
    expect(calculateQualityScore({ deep: 20, light: 50, rem: 25, wake: 5 })).toBe(100)
  })

  it('does NOT cap score at calibrationQuality === 0.3 (strict <)', () => {
    // Mutant `<= 0.3` would force the cap-at-50 path here.
    expect(calculateQualityScore({ deep: 20, light: 50, rem: 25, wake: 5 }, 0.3)).toBe(100)
  })

  it('caps score at 50 for calibrationQuality just below 0.3', () => {
    expect(calculateQualityScore({ deep: 20, light: 50, rem: 25, wake: 5 }, 0.29)).toBe(50)
  })
})

describe('piezoCalibrationQuality', () => {
  it('uses the profile quality score when one exists', () => {
    expect(piezoCalibrationQuality({ qualityScore: 0.12 })).toBe(0.12)
    expect(piezoCalibrationQuality({ qualityScore: 0 })).toBe(0)
  })

  it('treats a side that was never calibrated as full quality', () => {
    expect(piezoCalibrationQuality({ qualityScore: null })).toBe(1)
    expect(piezoCalibrationQuality(null)).toBe(1)
    expect(piezoCalibrationQuality(undefined)).toBe(1)
  })
})

describe('classifySleepStages — custom rulesets', () => {
  const custom = (patch: Partial<StageRuleset>): StageRuleset => ({ ...DEFAULT_STAGE_RULESET, ...patch })
  const flat = (n: number, hr = 60) => Array.from({ length: n }, (_, i) => vitalRow(i * 5, hr, 40, 14))

  it('takes the first matching rule, in order', () => {
    const rules = custom({
      rules: [
        { stage: 'rem', when: [{ metric: 'heartRate', op: '>=', value: 60 }] },
        { stage: 'deep', when: [{ metric: 'heartRate', op: '>=', value: 60 }] },
      ],
    })
    expect(classifySleepStages(flat(3), [], 1, rules).map(e => e.stage)).toEqual(['rem', 'rem', 'rem'])
  })

  it('uses the fallback when no rule matches, and an empty when always matches', () => {
    expect(classifySleepStages(flat(2), [], 1, custom({ rules: [], fallback: 'deep' })).map(e => e.stage)).toEqual(['deep', 'deep'])
    expect(classifySleepStages(flat(2), [], 1, custom({ rules: [{ stage: 'rem', when: [] }] })).map(e => e.stage)).toEqual(['rem', 'rem'])
  })

  it('never matches a condition on a missing metric', () => {
    const rules = custom({ rules: [{ stage: 'wake', when: [{ metric: 'movement', op: '<', value: 1000 }] }] })
    expect(classifySleepStages(flat(1), [], 1, rules)[0].stage).toBe('light')
    expect(classifySleepStages(flat(1), [movRow(0, 5)], 1, rules)[0].stage).toBe('wake')
  })

  it('supports every comparison operator at its boundary', () => {
    const at = (op: '<' | '<=' | '>' | '>=') => classifySleepStages(
      [vitalRow(0, 60, 40, 14)], [], 1,
      custom({ rules: [{ stage: 'rem', when: [{ metric: 'breathingRate', op, value: 14 }] }] }),
    )[0].stage
    expect(at('<')).toBe('light')
    expect(at('<=')).toBe('rem')
    expect(at('>')).toBe('light')
    expect(at('>=')).toBe('rem')
  })

  it('applies its own outlier limits', () => {
    const wide = custom({ outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRate: { min: 30, max: 200 } } })
    expect(classifySleepStages([vitalRow(0, 40)], [], 1, wide)[0].heartRate).toBe(40)
    expect(classifySleepStages([vitalRow(0, 40)], [], 1)[0].heartRate).toBeNull()
  })

  it('can turn off the heart-rate spike filter', () => {
    const v = [vitalRow(0, 60), vitalRow(5, 61), vitalRow(10, 100), vitalRow(15, 60), vitalRow(20, 61)]
    expect(classifySleepStages(v, [], 1)[2].heartRate).toBeNull()
    const off = custom({ outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRateSpikeStdDevs: 0 } })
    expect(classifySleepStages(v, [], 1, off)[2].heartRate).toBe(100)
  })

  it('can turn off smoothing', () => {
    const v = [vitalRow(0, 60), vitalRow(5, 60), vitalRow(10, 60)]
    const m = [movRow(0, 10), movRow(5, 300), movRow(10, 10)]
    expect(classifySleepStages(v, m, 1)[1].stage).toBe('light')
    expect(classifySleepStages(v, m, 1, custom({ smoothIsolatedEpochs: false }))[1].stage).toBe('wake')
  })

  it('applies its own transition constraints', () => {
    const rules = custom({
      rules: [
        { stage: 'wake', when: [{ metric: 'movement', op: '>', value: 200 }] },
        { stage: 'rem', when: [] },
      ],
      smoothIsolatedEpochs: false,
    })
    const v = [vitalRow(0, 60), vitalRow(5, 60)]
    const m = [movRow(0, 300), movRow(5, 10)]
    expect(classifySleepStages(v, m, 1, custom({ ...rules, transitions: [] })).map(e => e.stage)).toEqual(['wake', 'rem'])
    expect(classifySleepStages(v, m, 1, custom({ ...rules, transitions: [{ from: 'wake', to: 'rem', via: 'deep' }] })).map(e => e.stage)).toEqual(['wake', 'deep'])
  })

  it('switches to the low-signal rules below its own threshold', () => {
    const rules = custom({ lowSignalBelow: 0.8, lowSignalRules: [{ stage: 'rem', when: [] }] })
    expect(classifySleepStages(flat(1), [], 0.7, rules)[0].stage).toBe('rem')
    expect(classifySleepStages(flat(1), [], 0.8, rules)[0].stage).toBe('light')
  })

  it('movement-only never reports deep or REM', () => {
    const v = [70, 70, 55, 55, 55, 70, 70].map((hr, i) => vitalRow(i * 5, hr, 10, 14))
    expect(classifySleepStages(v, [], 1).some(e => e.stage === 'deep')).toBe(true)
    expect(classifySleepStages(v, [], 1, MOVEMENT_ONLY_STAGE_RULESET).map(e => e.stage)).toEqual(Array(7).fill('light'))
  })
})

describe('scoreAgainstReference', () => {
  const epoch = (minute: number, stage: SleepEpoch['stage']): SleepEpoch => ({
    start: minute * 60_000, duration: 300_000, stage, heartRate: null, hrv: null, breathingRate: null, movement: null,
  })

  it('returns null when no epoch midpoint is covered', () => {
    expect(scoreAgainstReference([epoch(0, 'light')], [])).toBeNull()
    expect(scoreAgainstReference([epoch(0, 'light')], [{ start: 0, end: 150_000, stage: 'light' }])).toBeNull()
  })

  it('scores accuracy and kappa over covered epochs only', () => {
    const epochs = [epoch(0, 'light'), epoch(5, 'deep'), epoch(10, 'light'), epoch(15, 'deep'), epoch(30, 'rem')]
    const reference = [{ start: 0, end: 20 * 60_000, stage: 'light' as const }]
    expect(scoreAgainstReference(epochs, reference)).toMatchObject({ epochs: 4, accuracy: 0.5, kappa: 0 })
  })

  it('reports perfect agreement as kappa 1 and total chance agreement as null', () => {
    const reference = [
      { start: 0, end: 5 * 60_000, stage: 'light' as const },
      { start: 5 * 60_000, end: 10 * 60_000, stage: 'deep' as const },
    ]
    expect(scoreAgainstReference([epoch(0, 'light'), epoch(5, 'deep')], reference)).toMatchObject({ epochs: 2, accuracy: 1, kappa: 1 })
    expect(scoreAgainstReference([epoch(0, 'light')], reference)).toMatchObject({ epochs: 1, accuracy: 1, kappa: null })
  })

  describe('confusion matrix and recall', () => {
    // Reference: 3 light (0-15), 2 deep (15-25), 1 rem (25-30). No wake.
    const reference = [
      { start: 0, end: 15 * 60_000, stage: 'light' as const },
      { start: 15 * 60_000, end: 25 * 60_000, stage: 'deep' as const },
      { start: 25 * 60_000, end: 30 * 60_000, stage: 'rem' as const },
    ]
    // Predicted: light, light, deep | deep, wake | rem
    const epochs = [epoch(0, 'light'), epoch(5, 'light'), epoch(10, 'deep'), epoch(15, 'deep'), epoch(20, 'wake'), epoch(25, 'rem')]
    const scored = scoreAgainstReference(epochs, reference)
    if (!scored) throw new Error('expected a scored agreement')
    const result = scored

    it('keys the matrix reference stage -> predicted stage', () => {
      expect(result.confusion).toEqual({
        wake: { wake: 0, light: 0, deep: 0, rem: 0 },
        light: { wake: 0, light: 2, deep: 1, rem: 0 },
        deep: { wake: 1, light: 0, deep: 1, rem: 0 },
        rem: { wake: 0, light: 0, deep: 0, rem: 1 },
      })
    })

    it('rows sum to the reference epoch counts and the whole matrix to covered epochs', () => {
      const rowSum = (row: Record<string, number>) => Object.values(row).reduce((a, b) => a + b, 0)
      expect(rowSum(result.confusion.light)).toBe(3)
      expect(rowSum(result.confusion.deep)).toBe(2)
      expect(rowSum(result.confusion.rem)).toBe(1)
      expect(rowSum(result.confusion.wake)).toBe(0)
      expect(Object.values(result.confusion).reduce((sum, row) => sum + rowSum(row), 0)).toBe(result.epochs)
    })

    it('reports recall per reference stage and null for stages the reference lacks', () => {
      expect(result.recall).toEqual({ wake: null, light: 2 / 3, deep: 0.5, rem: 1 })
      expect(result.accuracy).toBeCloseTo(4 / 6)
    })

    it('keeps epochs, accuracy and kappa unchanged for existing callers', () => {
      const { epochs: n, accuracy, kappa } = result
      expect({ n, accuracy, kappa }).toEqual({ n: 6, accuracy: 4 / 6, kappa: expect.any(Number) })
    })
  })
})

describe('runStageClassifier statistics', () => {
  const bare: StageRuleset = {
    ...DEFAULT_STAGE_RULESET,
    outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRateSpikeStdDevs: 0 },
    smoothIsolatedEpochs: false,
    transitions: [],
    rules: [
      { stage: 'wake', when: [{ metric: 'movement', op: '>', value: 200 }] },
      { stage: 'deep', when: [{ metric: 'hrRatio', op: '<', value: 0.92 }] },
      { stage: 'rem', when: [{ metric: 'hrRatio', op: '>=', value: 0.95 }, { metric: 'hrv', op: '<', value: 25 }] },
      { stage: 'rem', when: [{ metric: 'hrRatio', op: '>=', value: 0.95 }, { metric: 'hrv', op: '<', value: 40 }] },
    ],
  }

  it('counts hits, standalone matches and which earlier rule shadows a rule that never fires', () => {
    const vitals = [vitalRow(0, 70, 20, 14), vitalRow(5, 70, 20, 14), vitalRow(10, 70, 20, 14), vitalRow(15, 60, 50, 14), vitalRow(20, 80, 20, 14), vitalRow(25, 80, 20, 14)]
    const movement = [movRow(0, 300), movRow(5, 10), movRow(10, 10), movRow(15, 10), movRow(20, 10), movRow(25, 10)]
    const { epochs, stats } = runStageClassifier(vitals, movement, 1, bare)
    expect(epochs.map(e => e.stage)).toEqual(['wake', 'rem', 'rem', 'deep', 'rem', 'rem'])
    expect(stats.epochs).toBe(6)
    expect(stats.lowSignal).toBe(false)
    expect(stats.ruleHits).toEqual([1, 1, 4, 0])
    expect(stats.ruleMatches).toEqual([1, 1, 5, 5])
    expect(stats.shadowedBy).toEqual([null, null, null, 2])
    expect(stats.fallbackHits).toBe(0)
    expect(stats.metricRanges.heartRate).toEqual({ min: 60, max: 80 })
    expect(stats.metricRanges.hrv).toEqual({ min: 20, max: 50 })
    expect(stats.metricRanges.movement).toEqual({ min: 10, max: 300 })
    expect(stats.metricRanges.hrRatio?.min).toBeCloseTo(60 / (430 / 6), 5)
    expect(stats.heartRateReadings).toBe(6)
    expect(stats.spikesDropped).toBe(0)
  })

  it('counts epochs changed by smoothing and by the transition constraints', () => {
    const smoothing: StageRuleset = { ...bare, smoothIsolatedEpochs: true }
    const flat = [vitalRow(0, 70, 50, 14), vitalRow(5, 70, 50, 14), vitalRow(10, 70, 50, 14)]
    const blip = runStageClassifier(flat, [movRow(0, 300), movRow(5, 10), movRow(10, 300)], 1, smoothing)
    expect(blip.epochs.map(e => e.stage)).toEqual(['wake', 'wake', 'wake'])
    expect(blip.stats.smoothed).toBe(1)
    expect(blip.stats.fallbackHits).toBe(1)

    const constrained: StageRuleset = { ...bare, transitions: [{ from: 'wake', to: 'deep', via: 'light' }] }
    const dip = [vitalRow(0, 80, 50, 14), vitalRow(5, 80, 50, 14), vitalRow(10, 60, 50, 14), vitalRow(15, 60, 50, 14)]
    const run = runStageClassifier(dip, [movRow(0, 300), movRow(5, 300)], 1, constrained)
    expect(run.epochs.map(e => e.stage)).toEqual(['wake', 'wake', 'light', 'deep'])
    expect(run.stats.transitionFixes).toBe(1)
  })

  it('reports an empty run and the low-signal list', () => {
    expect(runStageClassifier([], [], 1, bare).stats).toMatchObject({ epochs: 0, ruleHits: [0, 0, 0, 0], lowSignal: false })
    const low = runStageClassifier([vitalRow(0, 70, 50, 14)], [movRow(0, 300)], 0, bare)
    expect(low.stats.lowSignal).toBe(true)
    expect(low.stats.ruleHits).toEqual([1])
  })

  it('sums stats over nights, keeping normal and low-signal rules apart', () => {
    const a = runStageClassifier([vitalRow(0, 70, 50, 14), vitalRow(5, 70, 50, 14)], [movRow(0, 300)], 1, bare).stats
    const b = runStageClassifier([vitalRow(0, 70, 50, 14)], [movRow(0, 300)], 0, bare).stats
    const s = summarizeRuns([a, b])
    expect(s).toMatchObject({ epochs: 3, nights: 2, lowSignalNights: 1 })
    expect(s.rules).toMatchObject({ epochs: 2, hits: [1, 0, 0, 0], fallbackHits: 1 })
    expect(s.lowSignalRules).toMatchObject({ epochs: 1, hits: [1] })
    expect(s.metricRanges.movement).toEqual({ min: 300, max: 300 })
    expect(summarizeRuns([]).rules).toBeNull()
  })

  it('finds where two classifications of a night disagree', () => {
    const mk = (stages: SleepStage[]): SleepEpoch[] => stages.map((stage, i) => ({ start: i * 300_000, duration: 300_000, stage, heartRate: null, hrv: null, breathingRate: null, movement: null }))
    const diff = changedSegments(mk(['wake', 'light', 'light', 'deep', 'rem']), mk(['wake', 'deep', 'deep', 'deep', 'light']))
    expect(diff).toEqual({ changed: 3, total: 5, segments: [{ start: 300_000, end: 900_000 }, { start: 1_200_000, end: 1_500_000 }] })
    expect(stageDurations(mk(['wake', 'wake', 'deep']))).toEqual({ wake: 600_000, light: 0, deep: 300_000, rem: 0 })
  })

  it('aggregates several nights for a preview, latest first', () => {
    const reference = [{ start: vitalRow(0, 70).timestamp.getTime(), end: vitalRow(60, 70).timestamp.getTime(), stage: 'wake' as const }]
    const latest = { vitalsData: [vitalRow(0, 70, 50, 14), vitalRow(5, 70, 50, 14)], movementData: [movRow(0, 300), movRow(5, 300)], calibrationQuality: 1, reference }
    const earlier = { vitalsData: [vitalRow(-1440, 70, 50, 14), vitalRow(-1435, 70, 50, 14)], movementData: [], calibrationQuality: 1, reference: [] }
    const out = classifyNights([latest, earlier], bare)
    expect(out).not.toBeNull()
    expect(out?.latestEpochs.map(e => e.stage)).toEqual(['wake', 'wake'])
    expect(out?.summary.blocks).toHaveLength(1)
    expect(out?.summary.distribution).toEqual({ wake: 50, light: 50, deep: 0, rem: 0 })
    expect(out?.summary.durations.wake).toBe(300_000)
    expect(out?.summary.agreement).toMatchObject({ epochs: 2, accuracy: 1 })
    expect(out?.summary.stats.nights).toBe(2)
    expect(classifyNights([{ ...earlier, vitalsData: [] }], bare)).toBeNull()
  })

  it('keeps an empty latest night as the latest night instead of promoting an older one', () => {
    const latest = { vitalsData: [], movementData: [], calibrationQuality: 1, reference: [] }
    const earlier = { vitalsData: [vitalRow(-1440, 70, 50, 14), vitalRow(-1435, 70, 50, 14)], movementData: [], calibrationQuality: 1, reference: [] }
    const out = classifyNights([latest, earlier], bare)
    expect(out?.latestEpochs).toEqual([])
    expect(out?.summary.blocks).toEqual([])
    expect(out?.summary.stats.nights).toBe(1)
    expect(out?.summary.distribution.light).toBe(100)
  })
})

describe('runStageClassifier — shadowing by several earlier rules', () => {
  const bare: StageRuleset = {
    ...DEFAULT_STAGE_RULESET,
    outliers: { ...DEFAULT_STAGE_RULESET.outliers, heartRateSpikeStdDevs: 0 },
    smoothIsolatedEpochs: false,
    transitions: [],
    rules: [
      { stage: 'wake', when: [{ metric: 'movement', op: '>', value: 200 }] },
      { stage: 'deep', when: [{ metric: 'heartRate', op: '<', value: 65 }] },
      { stage: 'rem', when: [{ metric: 'heartRate', op: '>=', value: 50 }] },
    ],
  }
  const restless = (minute: number) => ({ v: vitalRow(minute, 70, 40, 14), m: movRow(minute, 300) })
  const calm = (minute: number) => ({ v: vitalRow(minute, 60, 40, 14), m: movRow(minute, 10) })

  it('credits the earlier rule that took the most epochs, whichever order they came in', () => {
    const wakeFirst = [restless(0), calm(5), calm(10)]
    const a = runStageClassifier(wakeFirst.map(e => e.v), wakeFirst.map(e => e.m), 1, bare).stats
    expect(a.ruleHits).toEqual([1, 2, 0])
    expect(a.ruleMatches).toEqual([1, 2, 3])
    expect(a.shadowedBy).toEqual([null, null, 1])

    const deepFirst = [calm(0), calm(5), restless(10)]
    const b = runStageClassifier(deepFirst.map(e => e.v), deepFirst.map(e => e.m), 1, bare).stats
    expect(b.shadowedBy).toEqual([null, null, 1])

    const tie = [restless(0), calm(5)]
    const c = runStageClassifier(tie.map(e => e.v), tie.map(e => e.m), 1, bare).stats
    expect(c.shadowedBy).toEqual([null, null, 0])
  })
})

describe('mergeRunStats', () => {
  const base: StageRunStats = {
    epochs: 0,
    lowSignal: false,
    ruleHits: [0, 0, 0],
    ruleMatches: [0, 0, 0],
    shadowedBy: [null, null, null],
    fallbackHits: 0,
    metricRanges: { hrRatio: null, heartRate: null, hrv: null, breathingRate: null, movement: null },
    heartRateReadings: 0,
    spikesDropped: 0,
    smoothed: 0,
    transitionFixes: 0,
  }

  it('is null without runs', () => {
    expect(mergeRunStats([])).toBeNull()
  })

  it('sums counts and widens metric ranges, skipping nights without a metric', () => {
    const a = { ...base, epochs: 4, fallbackHits: 1, heartRateReadings: 4, spikesDropped: 1, smoothed: 2, transitionFixes: 1, metricRanges: { ...base.metricRanges, heartRate: { min: 60, max: 70 }, hrv: { min: 20, max: 30 } } }
    const b = { ...base, epochs: 2, fallbackHits: 2, heartRateReadings: 2, spikesDropped: 0, smoothed: 1, transitionFixes: 3, metricRanges: { ...base.metricRanges, heartRate: { min: 55, max: 65 } } }
    const merged = mergeRunStats([a, b])
    expect(merged).toMatchObject({ epochs: 6, fallbackHits: 3, heartRateReadings: 6, spikesDropped: 1, smoothed: 3, transitionFixes: 4, lowSignal: false })
    expect(merged?.metricRanges).toEqual({ hrRatio: null, heartRate: { min: 55, max: 70 }, hrv: { min: 20, max: 30 }, breathingRate: null, movement: null })
  })

  it('keeps a shadowing rule only when the rule matched but never fired in any night', () => {
    const fired = { ...base, ruleHits: [1, 0, 0], ruleMatches: [1, 0, 2], shadowedBy: [null, null, 0] }
    const silent = { ...base, ruleHits: [0, 1, 0], ruleMatches: [0, 1, 1], shadowedBy: [null, null, 1] }
    const unused = { ...base, ruleHits: [0, 0, 0], ruleMatches: [0, 0, 0], shadowedBy: [null, null, null] }
    const merged = mergeRunStats([unused, fired, silent])
    expect(merged?.ruleHits).toEqual([1, 1, 0])
    expect(merged?.ruleMatches).toEqual([1, 1, 3])
    expect(merged?.shadowedBy).toEqual([null, null, 0])
    expect(mergeRunStats([unused])?.shadowedBy).toEqual([null, null, null])
  })

  it('reads a shorter rule list as zeros and reports no shadow when none was recorded', () => {
    const inconsistent = { ...base, ruleHits: [0, 0, 0], ruleMatches: [0, 0, 2], shadowedBy: [null, null, null] }
    const short = { ...base, ruleHits: [0], ruleMatches: [1], shadowedBy: [null] }
    const merged = mergeRunStats([inconsistent, short])
    expect(merged?.ruleHits).toEqual([0, 0, 0])
    expect(merged?.ruleMatches).toEqual([1, 0, 2])
    expect(merged?.shadowedBy).toEqual([null, null, null])
  })
})
