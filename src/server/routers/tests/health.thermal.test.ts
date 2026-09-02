/**
 * Tests for health.thermal — the per-side verdict that reconciles commanded
 * state (device_state) against delivered flow (latest pump RPM). The whole
 * point of the endpoint is catching the "powered + target set but pump at 0
 * rpm → TEC locked → bed drifts cold" divergence, so the stalled cases are
 * the ones that matter.
 *
 * db + biometricsDb are mocked with a chain keyed by table reference. The
 * device_state query runs once per side in left→right order, so its mock
 * returns rows from a queue in that order.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deviceSettings, deviceState } from '@/src/db/schema'
import { bedTemp, flowReadings, freezerTemp } from '@/src/db/biometrics-schema'

const guardMock = vi.hoisted(() => ({ shouldBlock: vi.fn<(side: string) => boolean>(() => false) }))
const homekitMock = vi.hoisted(() => ({ getHomekitStagedTargetF: vi.fn<(side: string) => number | null>(() => null) }))

// Rows returned per table. device_state is a left→right queue (one query/side).
const rows = vi.hoisted(() => ({
  settings: [] as unknown[],
  deviceStateQueue: [] as unknown[][],
  deviceStateCursor: { i: 0 },
  flow: [] as unknown[],
  freezer: [] as unknown[],
  bed: [] as unknown[],
}))

const dbMock = vi.hoisted(() => {
  const makeChain = (resolve: () => unknown[]) => {
    const chain: Record<string, unknown> = {}
    const passthrough = () => chain
    chain.where = passthrough
    chain.orderBy = passthrough
    chain.limit = passthrough
    chain.all = () => resolve()
    return chain
  }
  return { makeChain }
})

vi.mock('@/src/scheduler', () => ({ getJobManager: vi.fn() }))
vi.mock('@/src/scheduler/instance', () => ({ getJobManager: vi.fn() }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: vi.fn(),
  getDacMonitorIfRunning: vi.fn(),
}))
vi.mock('@/src/hardware/iptablesCheck', () => ({ checkIptables: vi.fn(() => ({ ok: true, rules: [] })) }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: guardMock.shouldBlock }))
vi.mock('@/src/homekit/accessories/sideController', () => ({ getHomekitStagedTargetF: homekitMock.getHomekitStagedTargetF }))

function resolveFor(table: unknown): unknown[] {
  if (table === deviceSettings) return rows.settings
  if (table === deviceState) {
    const out = rows.deviceStateQueue[rows.deviceStateCursor.i] ?? []
    rows.deviceStateCursor.i += 1
    return out
  }
  if (table === flowReadings) return rows.flow
  if (table === freezerTemp) return rows.freezer
  if (table === bedTemp) return rows.bed
  return []
}

vi.mock('@/src/db', () => {
  const select = vi.fn(() => ({
    from: (table: unknown) => dbMock.makeChain(() => resolveFor(table)),
  }))
  return {
    db: { select },
    biometricsDb: { select },
    sqlite: { pragma: vi.fn() },
  }
})

const { healthRouter } = await import('@/src/server/routers/health')
const caller = healthRouter.createCaller({})

const FRESH = new Date(Date.now() - 30_000) // 30s old → not stale

beforeEach(() => {
  guardMock.shouldBlock.mockReset().mockReturnValue(false)
  homekitMock.getHomekitStagedTargetF.mockReset().mockReturnValue(null)
  rows.settings = [{ enabled: false }]
  rows.deviceStateQueue = []
  rows.deviceStateCursor.i = 0
  rows.flow = []
  rows.freezer = []
  rows.bed = []
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('health.thermal verdicts', () => {
  it('off when the side is not powered', async () => {
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    const res = await caller.thermal({})
    expect(res.sides.map(s => s.verdict)).toEqual(['off', 'off'])
  })

  it('reports null target/current on an off side rather than the level-0 (83°F) readback', async () => {
    // Powering off sets heat level 0, which round-trips through
    // levelToFahrenheit() to a phantom 83°F and lands in device_state. An off
    // side must not surface that as a real temperature.
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: false, targetTemperature: 83, currentTemperature: 83, isAlarmVibrating: false, poweredOnAt: null }],
      [{ side: 'right', isPowered: false, targetTemperature: 83, currentTemperature: 83, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    const res = await caller.thermal({})
    expect(res.sides[0].targetTempF).toBeNull()
    expect(res.sides[0].currentTempF).toBeNull()
    expect(res.sides[1].targetTempF).toBeNull()
    expect(res.sides[1].currentTempF).toBeNull()
  })

  it('passes null target/current through on a powered side whose stored temps are null', async () => {
    // Powered branch with null stored temps (e.g. powered on but no readback
    // yet): target/current must surface as null rather than coercing to a
    // value, while the side still evaluates as on.
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: null, currentTemperature: null, isAlarmVibrating: false, poweredOnAt: new Date() }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: null, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    rows.flow = [{ timestamp: FRESH, leftPumpRpm: 1900, rightPumpRpm: 0, leftFlowrateCd: 2600, rightFlowrateCd: 0 }]
    const res = await caller.thermal({})
    expect(res.sides[0].targetTempF).toBeNull()
    expect(res.sides[0].currentTempF).toBeNull()
  })

  it('stalled when powered with a target but pump rpm is below the flow threshold', async () => {
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 81, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: new Date() }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    rows.flow = [{ timestamp: FRESH, leftPumpRpm: 0, rightPumpRpm: 2000, leftFlowrateCd: 0, rightFlowrateCd: 2600 }]
    const res = await caller.thermal({})
    const left = res.sides[0]
    expect(left.verdict).toBe('stalled')
    expect(left.note).toContain('TEC')
  })

  it('stalled when powered but the latest flow reading is stale (no fresh frames)', async () => {
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 81, currentTemperature: 72, isAlarmVibrating: false, poweredOnAt: new Date() }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    // Healthy rpm but the reading is 10 minutes old → pump not actually reporting.
    rows.flow = [{ timestamp: new Date(Date.now() - 600_000), leftPumpRpm: 1900, rightPumpRpm: 0, leftFlowrateCd: 2600, rightFlowrateCd: 0 }]
    const res = await caller.thermal({})
    const left = res.sides[0]
    expect(left.verdict).toBe('stalled')
    expect(left.note).toContain('no fresh pump reading')
  })

  it('delivering when powered, flowing, and target diverges from current', async () => {
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 85, currentTemperature: 72, isAlarmVibrating: false, poweredOnAt: new Date() }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    rows.flow = [{ timestamp: FRESH, leftPumpRpm: 1900, rightPumpRpm: 0, leftFlowrateCd: 2600, rightFlowrateCd: 0 }]
    const res = await caller.thermal({})
    expect(res.sides[0].verdict).toBe('delivering')
  })

  it('idle when powered and flowing but already at target', async () => {
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 80, currentTemperature: 80.5, isAlarmVibrating: false, poweredOnAt: new Date() }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    rows.flow = [{ timestamp: FRESH, leftPumpRpm: 1900, rightPumpRpm: 0, leftFlowrateCd: 2600, rightFlowrateCd: 0 }]
    const res = await caller.thermal({})
    expect(res.sides[0].verdict).toBe('idle')
  })

  it('treats the exact freshness, rpm, and target-delta boundaries as flowing and on-target', async () => {
    const now = new Date('2026-07-20T01:00:00Z').getTime()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 82, currentTemperature: 80, isAlarmVibrating: false, poweredOnAt: null }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: null, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    rows.flow = [{
      timestamp: new Date(now - 180_000),
      leftPumpRpm: 100,
      rightPumpRpm: 0,
      leftFlowrateCd: 1,
      rightFlowrateCd: 0,
    }]

    const left = (await caller.thermal({})).sides[0]
    expect(left.readingAgeSec).toBe(180)
    expect(left.pumpRpm).toBe(100)
    expect(left.verdict).toBe('idle')
  })

  it('maps asymmetric flow, water, and bed fields to the correct side', async () => {
    const poweredOnAt = new Date('2026-07-19T23:00:00Z')
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 80, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt }],
      [{ side: 'right', isPowered: true, targetTemperature: 75, currentTemperature: 74, isAlarmVibrating: true, poweredOnAt }],
    ]
    rows.flow = [{
      timestamp: FRESH,
      leftPumpRpm: 111,
      rightPumpRpm: 222,
      leftFlowrateCd: 333,
      rightFlowrateCd: 444,
    }]
    rows.freezer = [{
      leftWaterTemp: 1000,
      rightWaterTemp: 2000,
      heatsinkTemp: null,
      ambientTemp: null,
    }]
    rows.bed = [{ leftCenterTemp: 1500, rightCenterTemp: 2500 }]

    const result = await caller.thermal({})
    expect(result.sides).toEqual([
      expect.objectContaining({
        side: 'left',
        pumpRpm: 111,
        flowrate: 333,
        waterTempF: 50,
        bedSurfaceTempF: 59,
        isAlarmVibrating: false,
        poweredOnAt: poweredOnAt.toISOString(),
      }),
      expect.objectContaining({
        side: 'right',
        pumpRpm: 222,
        flowrate: 444,
        waterTempF: 68,
        bedSurfaceTempF: 77,
        isAlarmVibrating: true,
        poweredOnAt: poweredOnAt.toISOString(),
      }),
    ])
  })

  it('defaults absent settings and device-state flags to false', async () => {
    rows.settings = []
    rows.deviceStateQueue = [[], []]
    const result = await caller.thermal({})
    expect(result.pumpStallProtectionEnabled).toBe(false)
    expect(result.sides.map(side => ({
      isPowered: side.isPowered,
      isAlarmVibrating: side.isAlarmVibrating,
      poweredOnAt: side.poweredOnAt,
      verdict: side.verdict,
    }))).toEqual([
      { isPowered: false, isAlarmVibrating: false, poweredOnAt: null, verdict: 'off' },
      { isPowered: false, isAlarmVibrating: false, poweredOnAt: null, verdict: 'off' },
    ])
  })

  it('converts centi-°C water/bed/ambient sensors to °F and surfaces guard + settings flags', async () => {
    guardMock.shouldBlock.mockImplementation((side: string) => side === 'left')
    rows.settings = [{ enabled: true }]
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: true, targetTemperature: 81, currentTemperature: 70, isAlarmVibrating: true, poweredOnAt: new Date() }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    rows.flow = [{ timestamp: FRESH, leftPumpRpm: 0, rightPumpRpm: 0, leftFlowrateCd: 0, rightFlowrateCd: 0 }]
    // 2500 cd = 25.00°C = 77.0°F
    rows.freezer = [{ timestamp: FRESH, leftWaterTemp: 2500, rightWaterTemp: 2500, heatsinkTemp: 3000, ambientTemp: 2200 }]
    rows.bed = [{ timestamp: FRESH, leftCenterTemp: 2400, rightCenterTemp: 2400 }]

    const res = await caller.thermal({})
    expect(res.pumpStallProtectionEnabled).toBe(true)
    expect(res.heatsinkTempF).toBe(86) // 30.00°C
    expect(res.ambientTempF).toBeCloseTo(71.6, 1) // 22.00°C
    const left = res.sides[0]
    expect(left.waterTempF).toBe(77)
    expect(left.bedSurfaceTempF).toBeCloseTo(75.2, 1) // 24.00°C
    expect(left.guardBlocked).toBe(true)
    expect(left.isAlarmVibrating).toBe(true)
  })

  it('surfaces the hidden HomeKit staged target per side', async () => {
    // PR #670 F1: a guard-rejected HomeKit temp write leaves the requested
    // value staged for the next power-on. The alert card reads it from here.
    homekitMock.getHomekitStagedTargetF.mockImplementation(side => (side === 'left' ? 78 : null))
    rows.deviceStateQueue = [
      [{ side: 'left', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
      [{ side: 'right', isPowered: false, targetTemperature: null, currentTemperature: 70, isAlarmVibrating: false, poweredOnAt: null }],
    ]
    const res = await caller.thermal({})
    expect(res.sides[0].homekitStagedTargetF).toBe(78)
    expect(res.sides[1].homekitStagedTargetF).toBeNull()
    expect(homekitMock.getHomekitStagedTargetF).toHaveBeenCalledWith('left')
    expect(homekitMock.getHomekitStagedTargetF).toHaveBeenCalledWith('right')
  })
})
