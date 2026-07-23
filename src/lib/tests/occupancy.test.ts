import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LatestCapSenseSnapshot } from '@/src/streaming/piezoStream'

interface MovementRow { peak: number | null }
interface CalRow { parameters: unknown }

let movementRows: MovementRow[] = []
let calRows: CalRow[] = []
let snapshot: LatestCapSenseSnapshot | null = null

const drizzle = vi.hoisted(() => ({
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  gt: vi.fn((left: unknown, right: unknown) => ({ op: 'gt', left, right })),
  gte: vi.fn((left: unknown, right: unknown) => ({ op: 'gte', left, right })),
  isNull: vi.fn((column: unknown) => ({ op: 'isNull', column })),
  or: vi.fn((...conditions: unknown[]) => ({ op: 'or', conditions })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values })),
}))

vi.mock('drizzle-orm', () => drizzle)

const movementAll = vi.fn<() => MovementRow[]>(() => movementRows)
const calAll = vi.fn<() => CalRow[]>(() => calRows)

vi.mock('@/src/db/biometrics', () => ({
  biometricsDb: {
    select: (cols?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            all: () => {
              // Distinguish queries by selected columns: movement uses `peak`,
              // calibration uses `parameters`. Cheap heuristic — no SQL coupling.
              if (cols && 'peak' in cols) return movementAll()
              return calAll()
            },
          }),
        }),
      }),
    }),
  },
}))

vi.mock('@/src/db/biometrics-schema', () => ({
  movement: { side: {}, timestamp: {}, totalMovement: {} },
  calibrationProfiles: {
    side: {},
    sensorType: {},
    status: {},
    parameters: {},
    qualityScore: {},
  },
}))

vi.mock('@/src/streaming/piezoStream', () => ({
  getLatestCapSenseSnapshot: () => snapshot,
}))

import { getOccupancy } from '../occupancy'

const FIXED_NOW = 1_778_910_000_000
const BASELINE_CAL = {
  channels: { A: { mean: 14.45 }, B: { mean: 13.65 }, C: { mean: 19.3 } },
  threshold: 6.0,
  format: 'capSense2',
  ref: { mean: 1.157 },
}
const NAMED_CAPSENSE_CAL = {
  channels: {
    out: { mean: 1000, std: 10 },
    cen: { mean: 2000, std: 20 },
    in: { mean: 3000, std: 25 },
  },
  threshold: 6.0,
}

function makeFrame(side: 'left' | 'right', values: number[]): LatestCapSenseSnapshot {
  return {
    type: 'capSense2',
    ts: Math.floor(FIXED_NOW / 1000),
    receivedAtMs: FIXED_NOW - 500,
    left: side === 'left' ? values : [14.45, 14.45, 13.65, 13.65, 19.3, 19.3, 1.157, 1.157],
    right: side === 'right' ? values : [14.45, 14.45, 13.65, 13.65, 19.3, 19.3, 1.157, 1.157],
  }
}

function makeNamedFrame(side: 'left' | 'right', values: number[]): LatestCapSenseSnapshot {
  const baseline = [1000, 1000, 2000, 2000, 3000, 3000]
  return {
    type: 'capSense',
    ts: Math.floor(FIXED_NOW / 1000),
    receivedAtMs: FIXED_NOW - 500,
    left: side === 'left' ? values : baseline,
    right: side === 'right' ? values : baseline,
  }
}

describe('getOccupancy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_NOW))
    movementRows = []
    calRows = []
    snapshot = null
    movementAll.mockClear()
    calAll.mockClear()
    drizzle.gte.mockClear()
    drizzle.gt.mockClear()
    drizzle.isNull.mockClear()
    drizzle.or.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns occupied=false when both signals are quiet', () => {
    movementRows = [{ peak: 30 }]
    snapshot = makeFrame('left', [14.5, 14.4, 13.7, 13.6, 19.4, 19.2, 1.157, 1.157])
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.occupied).toBe(false)
    expect(r.movement.active).toBe(false)
    expect(r.level.active).toBe(false)
    expect(r.available).toBe(true)
    expect(drizzle.gt).toHaveBeenCalledWith(expect.anything(), 0)
  })

  it('returns occupied=true via the movement signal alone', () => {
    movementRows = [{ peak: 350 }]
    snapshot = null
    const r = getOccupancy('right')
    expect(r.movement.active).toBe(true)
    expect(r.movement.peakScore).toBe(350)
    expect(r.level.active).toBe(false)
    expect(r.occupied).toBe(true)
    expect(r.available).toBe(false)
  })

  it('queries movement from exactly fifteen minutes ago and treats the threshold as active', () => {
    movementRows = [{ peak: 50 }]

    const result = getOccupancy('left')

    expect(drizzle.gte).toHaveBeenCalledOnce()
    expect(drizzle.gte.mock.calls[0]?.[1]).toEqual(new Date(FIXED_NOW - 15 * 60_000))
    expect(drizzle.sql.mock.calls[0]?.[0]).toEqual(['MAX(', ')'])
    expect(result.movement).toEqual({ active: true, peakScore: 50 })
  })

  it('returns occupied=true via the level signal alone (still occupant)', () => {
    // Quiet movement, but channels well above baseline → deviation >> threshold
    movementRows = [{ peak: 5 }]
    snapshot = makeFrame('left', [25.0, 25.0, 23.0, 23.0, 30.0, 30.0, 1.157, 1.157])
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.movement.active).toBe(false)
    expect(r.level.active).toBe(true)
    expect(r.level.deviation).not.toBeNull()
    expect(r.level.deviation as number).toBeGreaterThan(6)
    expect(r.occupied).toBe(true)
  })

  it('applies reference-channel compensation', () => {
    // Channels deviate ~+3 each = +9 total; ref also drifted +1 from nominal,
    // so compensated deviation is 9 - 3*1 = 6, NOT above threshold (6.0 strict >).
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [17.45, 17.45, 16.65, 16.65, 22.3, 22.3, 2.157, 2.157])
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.deviation).toBeCloseTo(6, 10)
    expect(r.level.threshold).toBe(6)
  })

  it('uses strict greater-than for the calibrated deviation threshold', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [16.45, 16.45, 15.65, 15.65, 21.3, 21.3])
    calRows = [{ parameters: BASELINE_CAL }]

    const result = getOccupancy('left')
    expect(result.level.deviation).toBeCloseTo(6, 10)
    expect(result.level.active).toBe(false)
  })

  it('adds all three compensated channel deviations', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [15.45, 15.45, 15.65, 15.65, 22.3, 22.3])
    calRows = [{ parameters: BASELINE_CAL }]

    expect(getOccupancy('left').level.deviation).toBeCloseTo(6, 10)
  })

  it('ignores stale capSense frames', () => {
    movementRows = [{ peak: 0 }]
    snapshot = {
      type: 'capSense2',
      ts: Math.floor((FIXED_NOW - 60_000) / 1000),
      receivedAtMs: FIXED_NOW - 60_000, // 60s old → stale
      left: [25, 25, 23, 23, 30, 30, 1.157, 1.157],
      right: [14.45, 14.45, 13.65, 13.65, 19.3, 19.3, 1.157, 1.157],
    }
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.deviation).toBeNull()
    expect(r.level.ageMs).toBeGreaterThan(30_000)
    expect(r.occupied).toBe(false)
  })

  it('accepts a capSense frame at the exact thirty-second freshness boundary', () => {
    movementRows = [{ peak: 0 }]
    snapshot = {
      ...makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157]),
      receivedAtMs: FIXED_NOW - 30_000,
    }
    calRows = [{ parameters: BASELINE_CAL }]

    const result = getOccupancy('left')
    expect(result.level.ageMs).toBe(30_000)
    expect(result.level.deviation).not.toBeNull()
    expect(result.available).toBe(true)
  })

  it('skips level signal for legacy capSense (Pod 3) frames', () => {
    movementRows = [{ peak: 0 }]
    snapshot = {
      type: 'capSense',
      ts: Math.floor(FIXED_NOW / 1000),
      receivedAtMs: FIXED_NOW - 500,
      left: 2000,
      right: 100,
    }
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.deviation).toBeNull()
    expect(r.level.threshold).toBeNull()
    expect(calAll).not.toHaveBeenCalled()
  })

  it('detects named-channel capSense presence with a missing-format calibration', () => {
    movementRows = [{ peak: 0 }]
    // Pair averages are 1030/2040/3050 → |z| sum 3 + 2 + 2 = 7.
    snapshot = makeNamedFrame('left', [1020, 1040, 2020, 2060, 3025, 3075])
    calRows = [{ parameters: NAMED_CAPSENSE_CAL }]

    const result = getOccupancy('left')

    expect(result.level).toEqual({ active: true, deviation: 7, threshold: 6, ageMs: 500 })
    expect(result.occupied).toBe(true)
    expect(result.available).toBe(true)
  })

  it('accepts an explicit capSense format and keeps the threshold strict', () => {
    movementRows = [{ peak: 0 }]
    // |z| sum 2 + 2 + 2 = exactly 6, which is not above the threshold.
    snapshot = makeNamedFrame('right', [1020, 1020, 2040, 2040, 3050, 3050])
    calRows = [{ parameters: { ...NAMED_CAPSENSE_CAL, format: 'capSense' } }]

    const result = getOccupancy('right')

    expect(result.level).toEqual({ active: false, deviation: 6, threshold: 6, ageMs: 500 })
    expect(result.occupied).toBe(false)
    expect(result.available).toBe(true)
  })

  it('uses absolute named-channel z-scores for below-baseline presence', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeNamedFrame('left', [970, 970, 1960, 1960, 2950, 2950])
    calRows = [{ parameters: NAMED_CAPSENSE_CAL }]

    const result = getOccupancy('left')

    expect(result.level.deviation).toBe(7)
    expect(result.level.active).toBe(true)
  })

  it('rejects a capSense2 calibration for a named-channel capSense frame', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeNamedFrame('left', [1030, 1030, 2040, 2040, 3050, 3050])
    calRows = [{ parameters: BASELINE_CAL }]

    const result = getOccupancy('left')

    expect(result.level).toMatchObject({ active: false, deviation: null, threshold: null })
    expect(result.available).toBe(false)
  })

  it.each([0, -1, Number.NaN])('rejects named-channel calibration std=%s', (std) => {
    movementRows = [{ peak: 0 }]
    snapshot = makeNamedFrame('left', [1030, 1030, 2040, 2040, 3050, 3050])
    calRows = [{
      parameters: {
        ...NAMED_CAPSENSE_CAL,
        channels: {
          ...NAMED_CAPSENSE_CAL.channels,
          cen: { ...NAMED_CAPSENSE_CAL.channels.cen, std },
        },
      },
    }]

    const result = getOccupancy('left')

    expect(result.level).toMatchObject({ active: false, deviation: null, threshold: null })
    expect(result.available).toBe(false)
  })

  it('rejects named-channel calibration with a missing channel', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeNamedFrame('left', [1030, 1030, 2040, 2040, 3050, 3050])
    calRows = [{
      parameters: {
        ...NAMED_CAPSENSE_CAL,
        channels: {
          ...NAMED_CAPSENSE_CAL.channels,
          cen: undefined,
        },
      },
    }]

    const result = getOccupancy('left')

    expect(result.level).toMatchObject({ active: false, deviation: null, threshold: null })
    expect(result.available).toBe(false)
  })

  it('rejects a non-finite named-channel calibration threshold', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeNamedFrame('left', [1030, 1030, 2040, 2040, 3050, 3050])
    calRows = [{ parameters: { ...NAMED_CAPSENSE_CAL, threshold: Number.NaN } }]

    const result = getOccupancy('left')

    expect(result.level).toMatchObject({ active: false, deviation: null, threshold: null })
    expect(result.available).toBe(false)
  })

  it('rejects non-finite named-channel frame values without marking presence available', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeNamedFrame('left', [Number.NaN, 1000, 2000, 2000, 3000, 3000])
    calRows = [{ parameters: NAMED_CAPSENSE_CAL }]

    const result = getOccupancy('left')

    expect(result.level).toEqual({ active: false, deviation: null, threshold: 6, ageMs: 500 })
    expect(result.available).toBe(false)
  })

  it('skips level signal when calibration is missing', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calRows = []
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.deviation).toBeNull()
    expect(r.occupied).toBe(false)
  })

  it('skips level signal when calibration format is not capSense2', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calRows = [{ parameters: { ...BASELINE_CAL, format: 'capSense' } }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
  })

  it('tolerates db errors and returns occupied=false', () => {
    movementAll.mockImplementationOnce(() => {
      throw new Error('db gone')
    })
    snapshot = null
    const r = getOccupancy('left')
    expect(r.movement.peakScore).toBe(0)
    expect(r.occupied).toBe(false)
  })

  it('skips level signal when capSense2 frame has fewer than 6 channel values', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23])
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.deviation).toBeNull()
    expect(r.level.threshold).toBe(BASELINE_CAL.threshold)
  })

  it('skips level signal when capSense2 frame omits the reference pair', () => {
    // 6 values, no ref pair — refDelta=0, raw deviation used directly.
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30])
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(true)
    expect(r.level.deviation as number).toBeGreaterThan(BASELINE_CAL.threshold)
  })

  it('falls back to nominal reference baseline when calibration omits ref.mean', () => {
    const calNoRef = { ...BASELINE_CAL }
    delete (calNoRef as { ref?: unknown }).ref
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.16, 1.16])
    calRows = [{ parameters: calNoRef }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(true)
  })

  it('skips level signal when calibration channels are malformed', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calRows = [{ parameters: { ...BASELINE_CAL, channels: { A: { mean: 'bad' }, B: { mean: 13.65 }, C: { mean: 19.3 } } } }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.threshold).toBeNull()
  })

  it.each(['B', 'C'] as const)('validates malformed calibration channel %s independently', (channel) => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calRows = [{
      parameters: {
        ...BASELINE_CAL,
        channels: {
          ...BASELINE_CAL.channels,
          [channel]: { mean: 'bad' },
        },
      },
    }]

    const result = getOccupancy('left')

    expect(result.level).toMatchObject({ active: false, deviation: null, threshold: null })
  })

  it('skips level signal when calibration threshold is missing', () => {
    const noThreshold = { ...BASELINE_CAL } as Partial<typeof BASELINE_CAL>
    delete noThreshold.threshold
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calRows = [{ parameters: noThreshold }]
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.threshold).toBeNull()
  })

  it('handles empty movement row (peak=null) without throwing', () => {
    movementRows = [{ peak: null }]
    snapshot = null
    const r = getOccupancy('right')
    expect(r.movement.peakScore).toBe(0)
    expect(r.movement.active).toBe(false)
  })

  it('reads the right-side channel array on a right-side request', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('right', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calRows = [{ parameters: BASELINE_CAL }]
    const r = getOccupancy('right')
    expect(r.level.active).toBe(true)
  })

  it('tolerates db errors during calibration lookup', () => {
    movementRows = [{ peak: 0 }]
    snapshot = makeFrame('left', [25, 25, 23, 23, 30, 30, 1.157, 1.157])
    calAll.mockImplementationOnce(() => {
      throw new Error('cal db gone')
    })
    const r = getOccupancy('left')
    expect(r.level.active).toBe(false)
    expect(r.level.threshold).toBeNull()
  })
})
