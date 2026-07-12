import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    dbMock.state.rows = {}
    dbMock.state.sideCalls = {}
    dbMock.state.throws = false
    capMock.snapshot = null
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
    warn.mockRestore()
  })
})
