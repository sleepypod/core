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
