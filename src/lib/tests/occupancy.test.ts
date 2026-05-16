import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LatestCapSenseSnapshot } from '@/src/streaming/piezoStream'

interface MovementRow { peak: number | null }
interface CalRow { parameters: unknown }

let movementRows: MovementRow[] = []
let calRows: CalRow[] = []
let snapshot: LatestCapSenseSnapshot | null = null

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
    snapshot = null
    movementAll.mockClear()
    calAll.mockClear()
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
  })

  it('returns occupied=true via the movement signal alone', () => {
    movementRows = [{ peak: 350 }]
    snapshot = null
    const r = getOccupancy('right')
    expect(r.movement.active).toBe(true)
    expect(r.movement.peakScore).toBe(350)
    expect(r.level.active).toBe(false)
    expect(r.occupied).toBe(true)
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
})
