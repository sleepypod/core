/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { DeviceStatus } from '../types'
import { PodVersion } from '../types'

vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const biometricsSchema = await import('@/src/db/biometrics-schema')
  const primary = new BetterSqlite3(':memory:')
  primary.pragma('foreign_keys = ON')
  const bio = new BetterSqlite3(':memory:')
  bio.pragma('foreign_keys = ON')
  return {
    db: drizzle(primary, { schema }),
    biometricsDb: drizzle(bio, { schema: biometricsSchema }),
    sqlite: primary,
    biometricsSqlite: bio,
    closeDatabase: vi.fn(),
    closeBiometricsDatabase: vi.fn(),
  }
})

import * as dbModule from '@/src/db'
import { DeviceStateSync, markSideMutated, _resetMutationStamps, getAlarmState } from '../deviceStateSync'

const { sqlite, biometricsSqlite } = dbModule as typeof dbModule & {
  sqlite: BetterSqlite3.Database
  biometricsSqlite: BetterSqlite3.Database
}

function resetSchema(): void {
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS device_state;
    CREATE TABLE device_state (
      side TEXT PRIMARY KEY,
      current_temperature REAL,
      target_temperature REAL,
      is_powered INTEGER NOT NULL DEFAULT 0,
      is_alarm_vibrating INTEGER NOT NULL DEFAULT 0,
      water_level TEXT DEFAULT 'unknown',
      powered_on_at INTEGER,
      last_updated INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
  ;(biometricsSqlite as any).exec(`
    DROP TABLE IF EXISTS water_level_readings;
    DROP TABLE IF EXISTS flow_readings;
    CREATE TABLE water_level_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      level TEXT NOT NULL
    );
    CREATE TABLE flow_readings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      left_flowrate_cd INTEGER,
      right_flowrate_cd INTEGER,
      left_pump_rpm INTEGER NOT NULL,
      right_pump_rpm INTEGER NOT NULL
    );
  `)
}

function seedSide(side: 'left' | 'right', isPowered: boolean, targetTemp: number | null = null): void {
  ;(sqlite as any)
    .prepare(
      `INSERT INTO device_state (side, is_powered, target_temperature, powered_on_at, last_updated)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(side) DO UPDATE SET
         is_powered = excluded.is_powered,
         target_temperature = excluded.target_temperature,
         powered_on_at = excluded.powered_on_at,
         last_updated = unixepoch()`
    )
    .run(side, isPowered ? 1 : 0, targetTemp, isPowered ? Math.floor(Date.now() / 1000) : null)
}

function readSide(side: 'left' | 'right') {
  return (sqlite as any)
    .prepare(`SELECT side, is_powered, target_temperature, current_temperature, powered_on_at FROM device_state WHERE side = ?`)
    .get(side) as { side: string, is_powered: number, target_temperature: number | null, current_temperature: number | null, powered_on_at: number | null } | undefined
}

const status = (overrides: Partial<DeviceStatus['rightSide']> & { side?: 'left' | 'right' } = {}): DeviceStatus => {
  const base: DeviceStatus['rightSide'] = {
    currentTemperature: 75,
    targetTemperature: 75,
    currentLevel: 0,
    targetLevel: 0,
    heatingDuration: 0,
  }
  return {
    leftSide: { ...base, ...(overrides.side === 'left' ? overrides : {}) },
    rightSide: { ...base, ...(overrides.side !== 'left' ? overrides : {}) },
    waterLevel: 'ok',
    isPriming: false,
    podVersion: 'H00' as DeviceStatus['podVersion'],
    sensorLabel: 'test',
  }
}

describe('DeviceStateSync — mutation freshness window', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    sync = new DeviceStateSync()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('preserves isPowered=true after setPower mutation when stale poll reports neutral', async () => {
    // Simulate setPower(right, true): mutation writes is_powered=1, target=83
    seedSide('right', true, 83)
    markSideMutated('right')

    // Stale firmware status arrives ~1s later: targetLevel=0, heatingDuration=0,
    // currentLevel=0 — the firmware hasn't picked up the new heat session yet.
    await sync.sync(status({
      side: 'right',
      currentTemperature: 81,
      targetTemperature: 75,
      currentLevel: 0,
      targetLevel: 0,
      heatingDuration: 0,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(1)
    expect(row?.target_temperature).toBe(83)
    expect(row?.powered_on_at).not.toBeNull()
    // Observation field should still update.
    expect(row?.current_temperature).toBe(81)
  })

  it('preserves isPowered=false after power_off when stale poll reports residual heat', async () => {
    seedSide('right', false, null)
    markSideMutated('right')

    // Stale firmware status: still showing currentLevel != 0 because the
    // heater hadn't fully wound down yet.
    await sync.sync(status({
      side: 'right',
      currentTemperature: 82,
      targetTemperature: 0,
      currentLevel: 5,
      targetLevel: 5,
      heatingDuration: 100,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(0)
    expect(row?.target_temperature).toBeNull()
  })

  it('observation fields (currentTemperature, waterLevel) update inside the freshness window', async () => {
    seedSide('right', true, 83)
    markSideMutated('right')

    await sync.sync(status({
      side: 'right',
      currentTemperature: 78,
      targetTemperature: 0,
      currentLevel: 0,
      targetLevel: 0,
      heatingDuration: 0,
    }))

    const row = readSide('right')
    expect(row?.current_temperature).toBe(78)
    // Powered-state fields preserved
    expect(row?.is_powered).toBe(1)
    expect(row?.target_temperature).toBe(83)
  })

  it('after the freshness window expires, sync resumes overwriting powered-state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-02T20:00:00Z'))

    seedSide('right', true, 83)
    markSideMutated('right')

    // First poll within window: skip
    await sync.sync(status({
      side: 'right',
      currentLevel: 0,
      targetLevel: 0,
      heatingDuration: 0,
    }))
    expect(readSide('right')?.is_powered).toBe(1)

    // Advance past freshness window (5s default)
    vi.setSystemTime(new Date('2026-05-02T20:00:06Z'))

    // Second poll, still showing neutral firmware status — should now reconcile
    // since freshness window has expired.
    await sync.sync(status({
      side: 'right',
      currentLevel: 0,
      targetLevel: 0,
      heatingDuration: 0,
    }))

    expect(readSide('right')?.is_powered).toBe(0)
  })

  it('does not affect the opposite side', async () => {
    seedSide('left', true, 80)
    seedSide('right', false, null)
    markSideMutated('right') // only right is fresh

    // Firmware: left says neutral (stale-looking), right says heating.
    // Without the gate, left would flip to false; with it, right is gated
    // but left is not — left should reconcile to is_powered=false because
    // its currentLevel=0 with no fresh mutation.
    await sync.sync({
      ...status(),
      leftSide: { currentTemperature: 75, targetTemperature: 75, currentLevel: 0, targetLevel: 0, heatingDuration: 0 },
      rightSide: { currentTemperature: 75, targetTemperature: 75, currentLevel: 5, targetLevel: 5, heatingDuration: 100 },
    })

    expect(readSide('left')?.is_powered).toBe(0) // not fresh, reconciled to neutral
    expect(readSide('right')?.is_powered).toBe(0) // fresh, preserved as off
  })

  it('without any mutation, sync writes the firmware-derived powered state directly', async () => {
    // No mutation marker — normal sync behavior.
    await sync.sync(status({
      side: 'right',
      currentLevel: 5,
      targetLevel: 5,
      heatingDuration: 100,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(1)
  })

  it('preserves null targetTemperature on a fresh power-off (no stale setpoint)', async () => {
    // Caller (auto-off / setPower(false)) wrote isPowered=0, target=null.
    // A stale firmware poll inside the freshness window must not resurrect
    // the previous targetTemperature.
    seedSide('right', false, null)
    markSideMutated('right')

    await sync.sync(status({
      side: 'right',
      currentTemperature: 80,
      targetTemperature: 83, // firmware still reports yesterday's setpoint briefly
      currentLevel: 0,
      targetLevel: 0,
      heatingDuration: 0,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(0)
    expect(row?.target_temperature).toBeNull()
  })
})

function readWaterLevels() {
  return (biometricsSqlite as any)
    .prepare(`SELECT id, timestamp, level FROM water_level_readings ORDER BY id ASC`)
    .all() as Array<{ id: number, timestamp: number, level: string }>
}

function readFlowReadings() {
  return (biometricsSqlite as any)
    .prepare(`SELECT id, timestamp, left_flowrate_cd, right_flowrate_cd, left_pump_rpm, right_pump_rpm FROM flow_readings ORDER BY id ASC`)
    .all() as Array<{
    id: number
    timestamp: number
    left_flowrate_cd: number | null
    right_flowrate_cd: number | null
    left_pump_rpm: number
    right_pump_rpm: number
  }>
}

function setAlarmVibrating(side: 'left' | 'right', isAlarmVibrating: boolean): void {
  ;(sqlite as any)
    .prepare(
      `INSERT INTO device_state (side, is_alarm_vibrating, last_updated)
       VALUES (?, ?, unixepoch())
       ON CONFLICT(side) DO UPDATE SET is_alarm_vibrating = excluded.is_alarm_vibrating, last_updated = unixepoch()`
    )
    .run(side, isAlarmVibrating ? 1 : 0)
}

describe('DeviceStateSync — power transition stamps poweredOnAt', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    sync = new DeviceStateSync()
  })

  it('OFF→ON stamps poweredOnAt when no mutation gate is active', async () => {
    seedSide('right', false, null)

    await sync.sync(status({
      side: 'right',
      currentLevel: 5,
      targetLevel: 5,
      heatingDuration: 100,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(1)
    expect(row?.powered_on_at).not.toBeNull()
  })

  it('ON→OFF clears poweredOnAt', async () => {
    seedSide('right', true, 80)

    await sync.sync(status({
      side: 'right',
      currentLevel: 0,
      targetLevel: 0,
      heatingDuration: 0,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(0)
    expect(row?.powered_on_at).toBeNull()
  })

  it('initial sync with no prior row treats wasPowered as false', async () => {
    // No seed; row absent
    await sync.sync(status({
      side: 'right',
      currentLevel: 5,
      targetLevel: 5,
      heatingDuration: 100,
    }))

    const row = readSide('right')
    expect(row?.is_powered).toBe(1)
    expect(row?.powered_on_at).not.toBeNull()
  })

  it('catches db errors thrown from upsertSide and logs', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Drop device_state table so the transaction throws
    ;(sqlite as any).exec(`DROP TABLE device_state`)

    await expect(
      sync.sync(status({
        side: 'right',
        currentLevel: 5,
        targetLevel: 5,
        heatingDuration: 100,
      }))
    ).resolves.toBeUndefined()

    expect(errSpy).toHaveBeenCalled()
    const msg = errSpy.mock.calls[0]?.[0]
    expect(String(msg)).toContain('failed to write device_state')
    errSpy.mockRestore()
  })
})

describe('DeviceStateSync — getAlarmState', () => {
  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
  })

  it('returns isAlarmVibrating per side from DB', () => {
    setAlarmVibrating('left', true)
    setAlarmVibrating('right', false)

    expect(getAlarmState()).toEqual({ left: true, right: false })
  })

  it('defaults to false for sides not yet present in DB', () => {
    // No rows present at all
    expect(getAlarmState()).toEqual({ left: false, right: false })
  })

  it('falls back to {left:false,right:false} on DB error', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(sqlite as any).exec(`DROP TABLE device_state`)

    expect(getAlarmState()).toEqual({ left: false, right: false })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('DeviceStateSync — recordWaterLevel', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    sync = new DeviceStateSync()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('writes ok on first sync, then rate-limits within 60s', async () => {
    await sync.sync(status({ side: 'right' }))
    expect(readWaterLevels().length).toBe(1)
    expect(readWaterLevels()[0]?.level).toBe('ok')

    // Within 60s window — no new write.
    vi.setSystemTime(new Date('2026-05-09T12:00:30Z'))
    await sync.sync(status({ side: 'right' }))
    expect(readWaterLevels().length).toBe(1)

    // After 60s — writes again.
    vi.setSystemTime(new Date('2026-05-09T12:01:01Z'))
    await sync.sync(status({ side: 'right' }))
    expect(readWaterLevels().length).toBe(2)
  })

  it('writes "low" when waterLevel is "low"', async () => {
    const s = status({ side: 'right' })
    s.waterLevel = 'low'
    await sync.sync(s)
    const rows = readWaterLevels()
    expect(rows[0]?.level).toBe('low')
  })

  it('logs and continues when biometricsDb write fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(biometricsSqlite as any).exec(`DROP TABLE water_level_readings`)

    await expect(sync.sync(status({ side: 'right' }))).resolves.toBeUndefined()
    expect(errSpy).toHaveBeenCalled()
    const msg = String(errSpy.mock.calls[0]?.[0] ?? '')
    expect(msg).toContain('failed to write water level')
    errSpy.mockRestore()
  })
})

describe('DeviceStateSync — recordFlowData', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    sync = new DeviceStateSync()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function frzHealthFrame(opts: {
    leftRpm?: number
    rightRpm?: number
    leftFlow?: number | null
    rightFlow?: number | null
  } = {}): Record<string, unknown> {
    const left: any = { pump: { rpm: opts.leftRpm ?? 100 }, temps: {} }
    const right: any = { pump: { rpm: opts.rightRpm ?? 100 }, temps: {} }
    if (opts.leftFlow !== null && opts.leftFlow !== undefined) left.temps.flowrate = opts.leftFlow
    if (opts.rightFlow !== null && opts.rightFlow !== undefined) right.temps.flowrate = opts.rightFlow
    return { left, right }
  }

  it('ignores frames missing pump/temps fields (e.g. piezo, capSense)', () => {
    sync.recordFlowData({ piezo: { samples: [] } })
    sync.recordFlowData({ left: { foo: 1 }, right: { bar: 2 } })
    sync.recordFlowData({ left: null, right: null })
    expect(readFlowReadings().length).toBe(0)
  })

  it('writes a row on the first frame and rate-limits writes within 60s', () => {
    sync.recordFlowData(frzHealthFrame({ leftFlow: 1.23, rightFlow: 1.21 }))
    expect(readFlowReadings().length).toBe(1)
    const row = readFlowReadings()[0]
    expect(row?.left_flowrate_cd).toBe(123)
    expect(row?.right_flowrate_cd).toBe(121)

    // Same minute → no second write
    vi.setSystemTime(new Date('2026-05-09T12:00:30Z'))
    sync.recordFlowData(frzHealthFrame({ leftFlow: 1.5, rightFlow: 1.5 }))
    expect(readFlowReadings().length).toBe(1)

    // After 60s → writes again
    vi.setSystemTime(new Date('2026-05-09T12:01:01Z'))
    sync.recordFlowData(frzHealthFrame({ leftFlow: 1.5, rightFlow: 1.5 }))
    expect(readFlowReadings().length).toBe(2)
  })

  it('persists null flowrate when frame omits temps.flowrate', () => {
    sync.recordFlowData(frzHealthFrame({ leftFlow: null, rightFlow: null }))
    const row = readFlowReadings()[0]
    expect(row?.left_flowrate_cd).toBeNull()
    expect(row?.right_flowrate_cd).toBeNull()
  })

  it('writes RPM with null flowrate when frame has no temps key at all', () => {
    sync.recordFlowData({
      left: { pump: { rpm: 150 } },
      right: { pump: { rpm: 175 } },
    })
    const row = readFlowReadings()[0]
    expect(row?.left_pump_rpm).toBe(150)
    expect(row?.right_pump_rpm).toBe(175)
    expect(row?.left_flowrate_cd).toBeNull()
    expect(row?.right_flowrate_cd).toBeNull()
  })

  it('logs and swallows when biometricsDb flow write fails', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(biometricsSqlite as any).exec(`DROP TABLE flow_readings`)

    sync.recordFlowData(frzHealthFrame({ leftFlow: 1.0, rightFlow: 1.0 }))
    expect(errSpy).toHaveBeenCalled()
    const msg = String(errSpy.mock.calls[0]?.[0] ?? '')
    expect(msg).toContain('failed to write flow readings')
    errSpy.mockRestore()
  })
})

describe('DeviceStateSync — flow anomaly detection', () => {
  let sync: DeviceStateSync
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    sync = new DeviceStateSync()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-09T12:00:00Z'))
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  function frame(opts: {
    leftRpm?: number
    rightRpm?: number
    leftFlow?: number | null
    rightFlow?: number | null
  } = {}): Record<string, unknown> {
    const left: any = { pump: { rpm: opts.leftRpm ?? 0 }, temps: {} }
    const right: any = { pump: { rpm: opts.rightRpm ?? 0 }, temps: {} }
    if (opts.leftFlow !== null && opts.leftFlow !== undefined) left.temps.flowrate = opts.leftFlow
    if (opts.rightFlow !== null && opts.rightFlow !== undefined) right.temps.flowrate = opts.rightFlow
    return { left, right }
  }

  function anomalyTypes(): string[] {
    return (warnSpy.mock.calls as unknown[][])
      .map((c: unknown[]) => String(c[0] ?? ''))
      .map((s: string) => {
        const m = s.match(/\[FlowAnomaly\] (\w+)/)
        return m ? m[1] : ''
      })
      .filter(Boolean)
  }

  it('warns when pump runs but flowrate is missing (left + right)', () => {
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: null, rightRpm: 200, rightFlow: null }))
    const types = anomalyTypes()
    expect(types).toContain('left_flowrate_missing')
    expect(types).toContain('right_flowrate_missing')
  })

  it('warns when pump runs but flowrate is near zero', () => {
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: 0.01, rightRpm: 100, rightFlow: 0.02 }))
    const types = anomalyTypes()
    expect(types).toContain('left_pump_no_flow')
    expect(types).toContain('right_pump_no_flow')
  })

  it('does NOT warn no-flow when pump is below RPM minimum', () => {
    sync.recordFlowData(frame({ leftRpm: 10, leftFlow: 0.0, rightRpm: 10, rightFlow: 0.0 }))
    expect(anomalyTypes()).not.toContain('left_pump_no_flow')
    expect(anomalyTypes()).not.toContain('right_pump_no_flow')
  })

  it('warns when left/right flow asymmetry exceeds threshold (and both above near-zero)', () => {
    // 5.0 vs 1.0 → 500cd vs 100cd, diff 400 > 300 threshold
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: 5.0, rightRpm: 100, rightFlow: 1.0 }))
    expect(anomalyTypes()).toContain('flow_asymmetry')
  })

  it('does NOT warn asymmetry when one side is near-zero', () => {
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: 5.0, rightRpm: 100, rightFlow: 0.0 }))
    // The asymmetry guard requires BOTH sides above near-zero; near-zero left is filtered
    expect(anomalyTypes()).not.toContain('flow_asymmetry')
  })

  it('warns on sudden flowrate spikes between consecutive frames', () => {
    // First frame primes prevFlow; cooldown blocks duplicate types so use distinct anomalies.
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: 1.0, rightRpm: 100, rightFlow: 1.0 }))
    // Second frame: jump by > 5.0 (500cd) — passes FLOWRATE_SUDDEN_CHANGE_CD = 500
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: 7.0, rightRpm: 100, rightFlow: 7.0 }))
    const types = anomalyTypes()
    expect(types).toContain('left_flow_spike')
    expect(types).toContain('right_flow_spike')
  })

  it('rate-limits repeated anomaly warnings of the same type', () => {
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: null, rightRpm: 0, rightFlow: 0.5 }))
    const before = anomalyTypes().filter(t => t === 'left_flowrate_missing').length
    expect(before).toBe(1)
    // Second emission within cooldown window
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: null, rightRpm: 0, rightFlow: 0.5 }))
    const after = anomalyTypes().filter(t => t === 'left_flowrate_missing').length
    expect(after).toBe(1)
  })

  it('emits the warning again after the cooldown window expires', () => {
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: null, rightRpm: 0, rightFlow: 0.5 }))
    expect(anomalyTypes().filter(t => t === 'left_flowrate_missing').length).toBe(1)
    // Advance past the 5-min cooldown
    vi.setSystemTime(new Date('2026-05-09T12:06:00Z'))
    sync.recordFlowData(frame({ leftRpm: 100, leftFlow: null, rightRpm: 0, rightFlow: 0.5 }))
    expect(anomalyTypes().filter(t => t === 'left_flowrate_missing').length).toBe(2)
  })
})

describe('DeviceStateSync — sync targetTemperature behaviour without mutation', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    sync = new DeviceStateSync()
  })

  it('clears targetTemperature when durationExpired and no mutation is active', async () => {
    seedSide('right', true, 83)

    await sync.sync(status({
      side: 'right',
      targetTemperature: 83,
      currentLevel: 5,
      targetLevel: 0,
      heatingDuration: 0,
    }))

    const row = readSide('right')
    expect(row?.target_temperature).toBeNull()
    expect(row?.is_powered).toBe(0)
  })

  it('writes targetTemperature from firmware when actively heating', async () => {
    await sync.sync(status({
      side: 'right',
      targetTemperature: 78,
      currentLevel: 5,
      targetLevel: 5,
      heatingDuration: 100,
    }))

    const row = readSide('right')
    expect(row?.target_temperature).toBe(78)
    expect(row?.is_powered).toBe(1)
  })

  it('podVersion field on status payload is irrelevant to upsert', async () => {
    const s = status({ side: 'right', currentLevel: 5, targetLevel: 5, heatingDuration: 100 })
    // Sanity that mocked enum is wired up through types
    s.podVersion = PodVersion.POD_4
    await sync.sync(s)
    expect(readSide('right')?.is_powered).toBe(1)
  })
})
