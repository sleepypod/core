/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { DeviceStatus } from '../types'

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
import { DeviceStateSync, markSideMutated, _resetMutationStamps } from '../deviceStateSync'

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
