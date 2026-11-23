import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import pod5J57 from '@/src/streaming/tests/fixtures/natsFramesPod5J57.json'
import { capSideChannels } from '@/src/streaming/normalizeFrame'
import type { LatestCapSenseSnapshot } from '@/src/streaming/piezoStream'

interface MovementRow { peak: number | null }
interface CalRow { parameters: unknown }
interface VitalsRow { timestamp: Date, heartRate: number | null, breathingRate: number | null }

let movementRows: MovementRow[] = []
let calRows: CalRow[] = []
let vitalsRows: VitalsRow[] = []
let snapshot: LatestCapSenseSnapshot | null = null

const drizzle = vi.hoisted(() => ({
  and: vi.fn((...conditions: unknown[]) => ({ op: 'and', conditions })),
  desc: vi.fn((col: unknown) => ({ op: 'desc', col })),
  eq: vi.fn((left: unknown, right: unknown) => ({ op: 'eq', left, right })),
  gte: vi.fn((left: unknown, right: unknown) => ({ op: 'gte', left, right })),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings: [...strings], values })),
}))

vi.mock('drizzle-orm', () => drizzle)

const movementAll = vi.fn<() => MovementRow[]>(() => movementRows)
const calAll = vi.fn<() => CalRow[]>(() => calRows)
const vitalsAll = vi.fn<() => VitalsRow[]>(() => vitalsRows)

vi.mock('@/src/db/biometrics', () => ({
  biometricsDb: {
    select: (cols?: Record<string, unknown>) => {
      // Distinguish queries by selected columns: movement uses `peak`, vitals
      // uses `heartRate`, calibration uses `parameters`. No SQL coupling.
      const all = () => {
        if (cols && 'peak' in cols) return movementAll()
        if (cols && 'heartRate' in cols) return vitalsAll()
        return calAll()
      }
      const limited = { limit: () => ({ all }) }
      return {
        from: () => ({
          where: () => ({ ...limited, orderBy: () => limited }),
        }),
      }
    },
  },
}))

vi.mock('@/src/db/biometrics-schema', () => ({
  movement: { side: {}, timestamp: {}, totalMovement: {} },
  vitals: { side: {}, timestamp: {}, heartRate: {}, breathingRate: {} },
  calibrationProfiles: {
    side: {},
    sensorType: {},
    status: {},
    parameters: {},
  },
}))

vi.mock('@/src/streaming/piezoStream', () => ({
  getLatestCapSenseSnapshot: () => snapshot,
}))

import { classify, getOccupancy, PERSON_MIN_ZONES } from '../occupancy'

const FIXED_NOW = 1_778_910_000_000
const BASELINE_CAL = {
  channels: { A: { mean: 14.45 }, B: { mean: 13.65 }, C: { mean: 19.3 } },
  threshold: 6.0,
  format: 'capSense2',
  ref: { mean: 1.157 },
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

describe('getOccupancy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_NOW))
    movementRows = []
    calRows = []
    vitalsRows = []
    snapshot = null
    movementAll.mockClear()
    calAll.mockClear()
    vitalsAll.mockClear()
    drizzle.gte.mockClear()
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

  it('skips level signal for Pod 3 capSense frames without a capSense profile', () => {
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
  })

  // Captured on a Pod 5 hub + J57 cover (NATS firmware, Pod 3 capSense dialect)
  // with a still sleeper on the left and the right side empty.
  describe('Pod 3-dialect capSense (NATS firmware)', () => {
    const POD3_CAL = { format: 'capSense', threshold: 300, channels: { out: { mean: 1540, std: 5 }, cen: { mean: 1870, std: 5 }, in: { mean: 2100, std: 5 } } }
    // Real frame from fixtures/natsFramesPod5J57.json, unwrapped the way piezoStream does.
    const natsFrame = (): LatestCapSenseSnapshot => {
      const f = pod5J57.capSense[0].decoded
      return {
        type: 'capSense',
        ts: Math.floor(FIXED_NOW / 1000),
        receivedAtMs: FIXED_NOW - 500,
        left: capSideChannels(f.left) ?? [],
        right: capSideChannels(f.right) ?? [],
      } as LatestCapSenseSnapshot
    }

    it('detects a still sleeper from level alone', () => {
      movementRows = [{ peak: 0 }]
      snapshot = natsFrame()
      calRows = [{ parameters: POD3_CAL }]
      const left = getOccupancy('left')
      expect(left.available).toBe(true)
      expect(left.level.active).toBe(true)
      expect(left.level.zones).toBe(2)
      expect(left.occupied).toBe(true)
      expect(left.classification).toBe('person')
    })

    it('reads the empty side as empty and available', () => {
      movementRows = [{ peak: 0 }]
      snapshot = natsFrame()
      calRows = [{ parameters: POD3_CAL }]
      const right = getOccupancy('right')
      expect(right.available).toBe(true)
      expect(right.level.active).toBe(false)
      expect(right.occupied).toBe(false)
    })

    it('ignores ref compensation and capSense2 profiles for Pod 3 frames', () => {
      movementRows = [{ peak: 0 }]
      snapshot = natsFrame()
      calRows = [{ parameters: BASELINE_CAL }]
      expect(getOccupancy('left').available).toBe(false)
    })

    it('rejects a capSense profile missing a channel', () => {
      movementRows = [{ peak: 0 }]
      snapshot = natsFrame()
      calRows = [{ parameters: { ...POD3_CAL, channels: { out: { mean: 1 }, cen: { mean: 1 } } } }]
      expect(getOccupancy('left').level.deviation).toBeNull()
    })
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

describe('getOccupancy — classification', () => {
  const PERSON_FRAME = [25.0, 25.0, 23.0, 23.0, 30.0, 30.0, 1.157, 1.157] // all three zones ~+10
  // One zone carries the whole load: head +7, torso/legs at baseline.
  const PET_FRAME = [21.45, 21.45, 13.65, 13.65, 19.3, 19.3, 1.157, 1.157]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FIXED_NOW))
    calRows = [{ parameters: BASELINE_CAL }]
    movementRows = [{ peak: 0 }]
    vitalsRows = []
    vitalsAll.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports per-zone deviations and the lit-zone count', () => {
    snapshot = makeFrame('left', PERSON_FRAME)
    const r = getOccupancy('left')
    expect(r.level.zoneDeviations?.map(d => Math.round(d))).toEqual([11, 9, 11])
    expect(r.level.zones).toBe(3)
  })

  it('classifies a three-zone load as a person', () => {
    snapshot = makeFrame('left', PERSON_FRAME)
    const r = getOccupancy('left')
    expect(r.occupied).toBe(true)
    expect(r.classification).toBe('person')
  })

  it('classifies a single-zone load above the sum threshold as light (pet)', () => {
    snapshot = makeFrame('left', PET_FRAME)
    const r = getOccupancy('left')
    expect(r.level.active).toBe(true)
    expect(r.level.zones).toBe(1)
    expect(r.occupied).toBe(true)
    expect(r.classification).toBe('light')
  })

  it('a zone counts as lit only above a third of the calibrated threshold', () => {
    // Head +2.5 (> 2.0), torso +1.9 (< 2.0), legs +2.1 (> 2.0) → 2 zones, sum 6.5 > 6.
    snapshot = makeFrame('left', [16.95, 16.95, 15.55, 15.55, 21.4, 21.4, 1.157, 1.157])
    const r = getOccupancy('left')
    expect(r.level.zones).toBe(PERSON_MIN_ZONES)
    expect(r.classification).toBe('person')
  })

  it('upgrades a single-zone load to person on human-range vitals', () => {
    snapshot = makeFrame('left', PET_FRAME)
    vitalsRows = [{ timestamp: new Date(FIXED_NOW - 60_000), heartRate: 58, breathingRate: 13 }]
    const r = getOccupancy('left')
    expect(r.vitals).toEqual({ heartRate: 58, breathingRate: 13, humanRange: true })
    expect(r.classification).toBe('person')
  })

  it('never downgrades a multi-zone load on out-of-range vitals', () => {
    snapshot = makeFrame('left', PERSON_FRAME)
    vitalsRows = [{ timestamp: new Date(FIXED_NOW - 60_000), heartRate: 150, breathingRate: 30 }]
    const r = getOccupancy('left')
    expect(r.vitals.humanRange).toBe(false)
    expect(r.classification).toBe('person')
  })

  it('ignores vitals older than five minutes', () => {
    snapshot = makeFrame('left', PET_FRAME)
    vitalsRows = [{ timestamp: new Date(FIXED_NOW - 6 * 60_000), heartRate: 58, breathingRate: 13 }]
    const r = getOccupancy('left')
    expect(r.vitals.humanRange).toBeNull()
    expect(r.classification).toBe('light')
  })

  it('treats a vitals row with both readings null as absent', () => {
    snapshot = makeFrame('left', PET_FRAME)
    vitalsRows = [{ timestamp: new Date(FIXED_NOW), heartRate: null, breathingRate: null }]
    expect(getOccupancy('left').vitals.humanRange).toBeNull()
  })

  it('judges human range on whichever reading is present', () => {
    snapshot = makeFrame('left', PET_FRAME)
    vitalsRows = [{ timestamp: new Date(FIXED_NOW), heartRate: 62, breathingRate: null }]
    expect(getOccupancy('left').vitals.humanRange).toBe(true)
    vitalsRows = [{ timestamp: new Date(FIXED_NOW), heartRate: null, breathingRate: 40 }]
    expect(getOccupancy('left').vitals.humanRange).toBe(false)
  })

  it('classifies movement-only occupancy as a person when the level signal is unavailable', () => {
    movementRows = [{ peak: 350 }]
    snapshot = null
    const r = getOccupancy('left')
    expect(r.level.zones).toBeNull()
    expect(r.classification).toBe('person')
  })

  it('classifies movement with an evaluable but single-zone level as light', () => {
    movementRows = [{ peak: 350 }]
    // Quiet level: zones 0 — a pet pacing on the bed edge.
    snapshot = makeFrame('left', [14.5, 14.4, 13.7, 13.6, 19.4, 19.2, 1.157, 1.157])
    const r = getOccupancy('left')
    expect(r.occupied).toBe(true)
    expect(r.classification).toBe('light')
  })

  it('classifies an empty bed as none', () => {
    snapshot = makeFrame('left', [14.5, 14.4, 13.7, 13.6, 19.4, 19.2, 1.157, 1.157])
    expect(getOccupancy('left').classification).toBe('none')
  })

  it('tolerates a vitals db error', () => {
    snapshot = makeFrame('left', PERSON_FRAME)
    vitalsAll.mockImplementationOnce(() => {
      throw new Error('db gone')
    })
    const r = getOccupancy('left')
    expect(r.vitals.humanRange).toBeNull()
    expect(r.classification).toBe('person')
  })

  it('classify() is a pure function of its inputs', () => {
    const level = (zones: number | null) => ({ active: true, deviation: 9, threshold: 6, ageMs: 1, zoneDeviations: null, zones })
    const noVitals = { heartRate: null, breathingRate: null, humanRange: null }
    expect(classify(false, level(3), noVitals)).toBe('none')
    expect(classify(true, level(1), noVitals)).toBe('light')
    expect(classify(true, level(2), noVitals)).toBe('person')
    expect(classify(true, level(null), noVitals)).toBe('person')
    expect(classify(true, level(0), { ...noVitals, humanRange: true })).toBe('person')
    expect(classify(true, level(3), { ...noVitals, humanRange: false })).toBe('person')
  })
})
