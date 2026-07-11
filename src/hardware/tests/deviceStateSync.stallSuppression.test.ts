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

vi.mock('../pumpStallGuard', () => ({
  onFrame: vi.fn().mockResolvedValue(undefined),
}))

import * as dbModule from '@/src/db'
import { onFrame } from '../pumpStallGuard'
import { DeviceStateSync, _resetMutationStamps } from '../deviceStateSync'

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
      level TEXT NOT NULL,
      raw INTEGER,
      calibrated_empty INTEGER,
      calibrated_full INTEGER
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

/** DeviceStatus with both sides mid-session (powered, countdown running). */
function status(overrides: {
  targetLevel?: number
  heatingDuration?: number
  isPriming?: boolean
} = {}): DeviceStatus {
  const side: DeviceStatus['rightSide'] = {
    currentTemperature: 75,
    targetTemperature: 75,
    currentLevel: 5,
    targetLevel: overrides.targetLevel ?? 5,
    heatingDuration: overrides.heatingDuration ?? 7200,
  }
  return {
    leftSide: { ...side },
    rightSide: { ...side },
    waterLevel: 'ok',
    isPriming: overrides.isPriming ?? false,
    podVersion: 'H00' as DeviceStatus['podVersion'],
    sensorLabel: 'test',
  }
}

function frame(opts: { rpm?: number, duty?: number | null } = {}): Record<string, unknown> {
  const pump: any = { rpm: opts.rpm ?? 0 }
  if (opts.duty !== null && opts.duty !== undefined) pump.duty = opts.duty
  return {
    left: { pump: { ...pump }, temps: { flowrate: 25.0 } },
    right: { pump: { ...pump }, temps: { flowrate: 25.0 } },
  }
}

async function lastGuardInput(side: 'left' | 'right') {
  // runStallGuard is fire-and-forget; let its microtask settle.
  await Promise.resolve()
  await Promise.resolve()
  const calls = vi.mocked(onFrame).mock.calls
    .map(([input]) => input)
    .filter(input => input.side === side)
  return calls[calls.length - 1]
}

describe('DeviceStateSync — stall guard expected-stop suppression', () => {
  let sync: DeviceStateSync

  beforeEach(() => {
    resetSchema()
    _resetMutationStamps()
    vi.mocked(onFrame).mockClear()
    sync = new DeviceStateSync()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-11T08:00:00Z'))
    // DB says both sides are commanded active — the pre-fix code would
    // derive expectedActive=true from this alone.
    seedSide('left', true, 75)
    seedSide('right', true, 75)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('mid-session zero RPM still reaches the guard as expectedActive=true (real stall)', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 7200 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
    expect((await lastGuardInput('right'))?.expectedActive).toBe(true)
  })

  it('suppresses when firmware pump duty is 0 (commanded stop, not a stall)', async () => {
    sync.recordFlowData(frame({ rpm: 0, duty: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('does not suppress on duty alone when duty > 0 (stalled pump still driven)', async () => {
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('duty > 0 overrides priming — a driven-but-stopped pump is a stall even mid-prime', async () => {
    await sync.sync(status({ isPriming: true }))
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('duty > 0 overrides the session-end grace window', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 60 }))
    sync.recordFlowData(frame({ rpm: 0, duty: 65 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('falls back to device_state when the frame omits duty', async () => {
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('suppresses while priming', async () => {
    await sync.sync(status({ isPriming: true }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('suppresses within the grace window after priming ends, then resumes', async () => {
    await sync.sync(status({ isPriming: true }))
    await sync.sync(status({ isPriming: false }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)

    vi.setSystemTime(new Date('2026-07-11T08:02:01Z')) // 121s after prime end
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('suppresses when firmware targetLevel is 0 while device_state still says powered', async () => {
    // The field-observed failure: firmware commanded neutral, but
    // device_state.isPowered stays true because durationExpired requires
    // heatingDuration=0 too and currentLevel is still non-zero.
    await sync.sync(status({ targetLevel: 0, heatingDuration: 600 }))
    seedSide('left', true, 75) // sync's upsert may have flipped it; force the lagging-DB state
    seedSide('right', true, 75)
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('suppresses inside the session-end grace window (countdown nearly elapsed)', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 60 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('projects the countdown forward from the last poll', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 300 }))
    // No further polls; 250s later the projected remaining is ~50s ≤ grace.
    vi.setSystemTime(new Date('2026-07-11T08:04:10Z'))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(false)
  })

  it('stops trusting the projected countdown long past its end (stale snapshot)', async () => {
    await sync.sync(status({ targetLevel: 5, heatingDuration: 300 }))
    // 1000s later the projection is 700s past the session end — beyond the
    // 600s staleness bound, so a genuine stall in a later session is not
    // masked by the old snapshot.
    vi.setSystemTime(new Date('2026-07-11T08:16:40Z'))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })

  it('does not treat heatingDuration=0 with a non-neutral target as session end', async () => {
    // A firmware variant reporting no countdown during an active session
    // must stay on the plain device_state path, not be suppressed forever.
    await sync.sync(status({ targetLevel: 5, heatingDuration: 0 }))
    sync.recordFlowData(frame({ rpm: 0 }))
    expect((await lastGuardInput('left'))?.expectedActive).toBe(true)
  })
})
