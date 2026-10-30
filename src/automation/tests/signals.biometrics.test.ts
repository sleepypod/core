import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Eligibility has real SQLite/window tests; these fixtures isolate scalar conversion.
const eligibility = vi.hoisted(() => ({ allowed: true }))
vi.mock('@/src/biometrics/mechanical/eligibility', () => ({ isMechanicallyQualifiedVital: () => eligibility.allowed }))

// Hoisted DB mock — drives BiometricsSignalReader by stubbing the chained
// biometricsDb.select().from(table)[.where()].orderBy().limit().all() call.
// Rows are keyed by table; per-side tables (vitals, movement) resolve left
// then right, matching the reader's SIDES iteration order.
const dbMock = vi.hoisted(() => {
  const state = {
    rows: {} as Record<string, unknown[]>,
    sideCalls: {} as Record<string, number>,
    throws: false,
  }
  let tableInfo: Map<unknown, { name: string, perSide: boolean }> | null = null
  const setTables = (m: Map<unknown, { name: string, perSide: boolean }>) => {
    tableInfo = m
  }
  const select = vi.fn(() => ({
    from: (table: unknown) => {
      if (state.throws) throw new Error('biometrics db down')
      const info = tableInfo?.get(table)
      let key = info?.name ?? 'unknown'
      if (info?.perSide) {
        const n = state.sideCalls[key] ?? 0
        state.sideCalls[key] = n + 1
        key = `${key}.${n === 0 ? 'left' : 'right'}`
      }
      const terminal = { all: () => state.rows[key] ?? [] }
      const ordered = { orderBy: () => ({ limit: () => terminal }) }
      return { ...ordered, where: () => ordered }
    },
  }))
  return { state, select, setTables }
})

vi.mock('@/src/db', () => ({
  biometricsDb: { select: dbMock.select },
}))

const capMock = vi.hoisted(() => ({
  snapshot: null as Record<string, unknown> | null,
}))

vi.mock('@/src/streaming/piezoStream', () => ({
  getLatestCapSenseSnapshot: () => capMock.snapshot,
}))

const occupancyMock = vi.hoisted(() => ({
  bySide: {} as Record<string, { available: boolean, classification: 'person' | 'light' | 'none', zones: number | null }>,
}))

vi.mock('@/src/lib/occupancy', () => ({
  getOccupancy: (side: 'left' | 'right') => {
    const o = occupancyMock.bySide[side] ?? { available: false, classification: 'none', zones: null }
    return { available: o.available, classification: o.classification, level: { zones: o.zones } }
  },
}))

import { ambientLight, bedTemp, freezerTemp, movement, vitals } from '@/src/db/biometrics-schema'
import { reduceCap } from '../capReduce'
import { BiometricsSignalReader } from '../signals.biometrics'

dbMock.setTables(new Map<unknown, { name: string, perSide: boolean }>([
  [vitals, { name: 'vitals', perSide: true }],
  [movement, { name: 'movement', perSide: true }],
  [bedTemp, { name: 'bedTemp', perSide: false }],
  [freezerTemp, { name: 'freezerTemp', perSide: false }],
  [ambientLight, { name: 'ambientLight', perSide: false }],
]))

describe('reduceCap', () => {
  it('returns null for an empty array', () => {
    expect(reduceCap([])).toBeNull()
  })

  it('reduces a scalar (Pod 3) channel to degenerate stats', () => {
    expect(reduceCap([42])).toEqual({ max: 42, mean: 42, spread: 0, peakZone: null })
  })

  it('drops the two reference channels from a full capSense2 frame', () => {
    // [A1,A2,B1,B2,C1,C2,ref1,ref2] — refs (999) must not affect the stats.
    expect(reduceCap([10, 20, 30, 40, 50, 60, 999, 999])).toMatchObject({ max: 60, spread: 50, mean: 35 })
  })

  it('picks the paired zone (A/B/C) with the highest mean as peakZone', () => {
    // zone A mean=15, B mean=85, C mean=35 → B is index 1.
    expect(reduceCap([10, 20, 80, 90, 30, 40, 0, 0])).toMatchObject({ peakZone: 1 })
    // zone C dominant → index 2.
    expect(reduceCap([10, 10, 20, 20, 95, 95, 0, 0])).toMatchObject({ peakZone: 2 })
  })

  it('leaves peakZone null when the frame is not the 6-channel shape', () => {
    expect(reduceCap([10, 20, 30])).toMatchObject({ peakZone: null })
  })
})

describe('BiometricsSignalReader', () => {
  beforeEach(() => {
    eligibility.allowed = true
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:00:00Z'))
    dbMock.state.rows = {}
    dbMock.state.sideCalls = {}
    dbMock.state.throws = false
    capMock.snapshot = null
    occupancyMock.bySide = {}
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('surfaces fresh vitals, movement, environment, and cap signals with unit conversion', () => {
    const fresh = new Date(Date.now() - 1_000)
    dbMock.state.rows = {
      'vitals.left': [{ timestamp: fresh, heartRate: 55, hrv: 40, breathingRate: 14 }],
      'vitals.right': [{ timestamp: fresh, heartRate: 60, hrv: null, breathingRate: null }],
      'movement.left': [{ timestamp: fresh, totalMovement: 120 }],
      'movement.right': [{ timestamp: fresh, totalMovement: 30 }],
      'bedTemp': [{
        timestamp: fresh,
        ambientTemp: 2000, // 20.00°C → 68°F
        humidity: 4550, // 45.50%
        leftOuterTemp: 3000, // 86°F
        leftCenterTemp: 3100, // 87.8°F
        leftInnerTemp: 3200, // 89.6°F
        rightOuterTemp: 2900, // 84.2°F — only zone present on the right
        rightCenterTemp: null,
        rightInnerTemp: null,
      }],
      'freezerTemp': [{ timestamp: fresh, leftWaterTemp: 1500, rightWaterTemp: null }], // 15°C → 59°F
      'ambientLight': [{ timestamp: fresh, lux: 12 }],
    }
    capMock.snapshot = {
      type: 'capSense2',
      ts: Math.floor(Date.now() / 1000),
      receivedAtMs: Date.now() - 1_000,
      left: [10, 20, 30, 40, 50, 60, 999, 999],
      right: 42, // Pod 3 scalar shape
    }

    const out = new BiometricsSignalReader().read()

    expect(out['left.heartRate']).toBe(55)
    expect(out['left.hrv']).toBe(40)
    expect(out['left.breathingRate']).toBe(14)
    expect(out['right.heartRate']).toBe(60)
    // Null columns stay absent rather than mapping to 0.
    expect(out['right.hrv']).toBeUndefined()
    expect(out['right.breathingRate']).toBeUndefined()

    expect(out['left.movement']).toBe(120)
    expect(out['right.movement']).toBe(30)

    expect(out['ambient.temperature']).toBeCloseTo(68, 5)
    expect(out['ambient.humidity']).toBeCloseTo(45.5, 5)

    // Left has all three zones: mean / spread / inner-outer gradient.
    expect(out['left.surfaceTemp']).toBeCloseTo(87.8, 5)
    expect(out['left.surfaceTemp.spread']).toBeCloseTo(3.6, 5)
    expect(out['left.surfaceTemp.gradient']).toBeCloseTo(3.6, 5)
    // Right has a single zone: mean only — spread needs 2+, gradient needs inner+outer.
    expect(out['right.surfaceTemp']).toBeCloseTo(84.2, 5)
    expect(out['right.surfaceTemp.spread']).toBeUndefined()
    expect(out['right.surfaceTemp.gradient']).toBeUndefined()

    expect(out['left.waterTemp']).toBeCloseTo(59, 5)
    expect(out['right.waterTemp']).toBeUndefined()

    expect(out['ambient.light']).toBe(12)

    expect(out['left.cap.max']).toBe(60)
    expect(out['left.cap.mean']).toBe(35)
    expect(out['left.cap.spread']).toBe(50)
    // Scalar (Pod 3) side is wrapped into a one-element array before reducing.
    expect(out['right.cap.max']).toBe(42)
    expect(out['right.cap.mean']).toBe(42)
    expect(out['right.cap.spread']).toBe(0)
  })

  it('withholds unqualified vitals without hiding independent environmental signals', () => {
    eligibility.allowed = false
    dbMock.state.rows = {
      'vitals.left': [{ timestamp: new Date(Date.now() - 1000), heartRate: 55, hrv: 40, breathingRate: 14 }],
      'ambientLight': [{ timestamp: new Date(Date.now() - 1000), lux: 12 }],
    }
    const out = new BiometricsSignalReader().read()
    expect(out['left.heartRate']).toBeUndefined()
    expect(out['left.hrv']).toBeUndefined()
    expect(out['left.breathingRate']).toBeUndefined()
    expect(out['ambient.light']).toBe(12)
  })

  it('treats rows older than their freshness window as absent', () => {
    const staleShort = new Date(Date.now() - 6 * 60_000) // past the 5-min vitals/movement window
    const staleEnv = new Date(Date.now() - 16 * 60_000) // past the 15-min environment window
    dbMock.state.rows = {
      'vitals.left': [{ timestamp: staleShort, heartRate: 55, hrv: 40, breathingRate: 14 }],
      'vitals.right': [{ timestamp: staleShort, heartRate: 60, hrv: 41, breathingRate: 15 }],
      'movement.left': [{ timestamp: staleShort, totalMovement: 120 }],
      'movement.right': [{ timestamp: staleShort, totalMovement: 30 }],
      'bedTemp': [{ timestamp: staleEnv, ambientTemp: 2000, humidity: 4550, leftOuterTemp: 3000, leftCenterTemp: 3100, leftInnerTemp: 3200, rightOuterTemp: 2900, rightCenterTemp: null, rightInnerTemp: null }],
      'freezerTemp': [{ timestamp: staleEnv, leftWaterTemp: 1500, rightWaterTemp: 1600 }],
      'ambientLight': [{ timestamp: staleEnv, lux: 12 }],
    }
    capMock.snapshot = {
      type: 'capSense2',
      ts: Math.floor(Date.now() / 1000),
      receivedAtMs: Date.now() - 31_000, // past the 30s cap window
      left: [10, 20, 30, 40, 50, 60, 999, 999],
      right: [10, 20, 30, 40, 50, 60, 999, 999],
    }

    expect(new BiometricsSignalReader().read()).toEqual({})
  })

  it.each([
    new Date('2026-01-15T12:00:01Z'),
    new Date('invalid'),
    NaN, Infinity, -Infinity,
  ])('withholds malformed and future timestamps (%s) across all stored sources', (timestamp) => {
    dbMock.state.rows = {
      'vitals.left': [{ timestamp, heartRate: 55, hrv: 40, breathingRate: 14 }],
      'movement.left': [{ timestamp, totalMovement: 120 }],
      'bedTemp': [{ timestamp, ambientTemp: 2000, humidity: 4550, leftOuterTemp: 3000 }],
      'freezerTemp': [{ timestamp, leftWaterTemp: 1500 }],
      'ambientLight': [{ timestamp, lux: 12 }],
      'vitals.right': [{ timestamp: new Date(), heartRate: 60 }],
    }
    expect(new BiometricsSignalReader().read()).toEqual({ 'right.heartRate': 60 })
  })

  it('does not propagate malformed numeric readings or manufacture missing values', () => {
    const timestamp = new Date()
    dbMock.state.rows = {
      'vitals.left': [{ timestamp, heartRate: NaN, hrv: Infinity, breathingRate: '14' }],
      'movement.left': [{ timestamp, totalMovement: -Infinity }],
      'bedTemp': [{ timestamp, ambientTemp: Infinity, humidity: NaN, leftOuterTemp: NaN, leftCenterTemp: 3000, leftInnerTemp: Infinity }],
      'freezerTemp': [{ timestamp, leftWaterTemp: '1500', rightWaterTemp: 1500 }],
      'ambientLight': [{ timestamp, lux: -Infinity }],
    }
    capMock.snapshot = {
      type: 'capSense2', ts: Date.now() / 1000, receivedAtMs: Date.now(),
      left: [1, 2, NaN, 4, 5, 6, 0, 0], right: [10, 10, 10, 10, 10, 10, 0, 0],
    }
    expect(new BiometricsSignalReader().read()).toEqual({
      'left.surfaceTemp': 86, 'right.waterTemp': 59,
      'right.cap.max': 10, 'right.cap.mean': 10, 'right.cap.spread': 0,
    })
  })

  it.each([
    { receivedAtMs: 0 }, { receivedAtMs: Infinity }, { receivedAtMs: NaN },
    { receivedAtMs: Date.parse('2026-01-15T12:00:00Z') + 1 },
    { ts: 0 }, { ts: Infinity }, { ts: NaN },
    { ts: Date.parse('2026-01-15T12:00:01Z') / 1000 },
  ])('requires both cap receipt and source timestamps to be fresh (%j)', (overrides) => {
    capMock.snapshot = {
      type: 'capSense', ts: Date.now() / 1000, receivedAtMs: Date.now(),
      left: 42, right: 17, ...overrides,
    }
    expect(new BiometricsSignalReader().read()).toEqual({})
  })

  it('exposes the classified presence sensor as 1/0 only while presence is sensable', () => {
    occupancyMock.bySide = {
      left: { available: true, classification: 'person', zones: 3 },
      right: { available: true, classification: 'light', zones: 1 },
    }
    const out = new BiometricsSignalReader().read()
    expect(out['left.presence']).toBe(1)
    expect(out['left.presence.zones']).toBe(3)
    expect(out['right.presence']).toBe(0)
    expect(out['right.presence.zones']).toBe(1)
  })

  it('leaves presence undefined when the sensor is unavailable, so rules skip', () => {
    occupancyMock.bySide = { left: { available: false, classification: 'person', zones: null } }
    const out = new BiometricsSignalReader().read()
    expect(out['left.presence']).toBeUndefined()
    expect(out['left.presence.zones']).toBeUndefined()
    expect(out['right.presence']).toBeUndefined()
  })

  it('returns an empty snapshot when there are no rows and no cap snapshot', () => {
    expect(new BiometricsSignalReader().read()).toEqual({})
  })

  it('warns and degrades to an empty snapshot when the db read throws', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dbMock.state.throws = true
    expect(new BiometricsSignalReader().read()).toEqual({})
    expect(warn).toHaveBeenCalledWith(
      '[automation] BiometricsSignalReader.read failed:',
      expect.any(Error),
    )
  })
})
