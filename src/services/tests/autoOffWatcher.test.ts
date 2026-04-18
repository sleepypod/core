/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

// ── Shared mocks ──────────────────────────────────────────────────────────
const setPower = vi.fn(async () => {})
const connect = vi.fn(async () => {})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect, setPower }),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: vi.fn(),
}))

// In-memory primary + biometrics DBs
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

// The mock above adds `biometricsSqlite` alongside the real module's exports.
// Cast the import so TypeScript sees the augmented shape.
import * as dbModule from '@/src/db'
import { startAutoOffWatcher, stopAutoOffWatcher } from '@/src/services/autoOffWatcher'
const { sqlite, biometricsSqlite } = dbModule as typeof dbModule & {
  biometricsSqlite: BetterSqlite3.Database
}

function resetSchema(): void {
  // Wipe and recreate everything the watcher reads.
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS device_settings;
    DROP TABLE IF EXISTS side_settings;
    DROP TABLE IF EXISTS device_state;
    DROP TABLE IF EXISTS run_once_sessions;

    CREATE TABLE device_settings (
      id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      temperature_unit TEXT NOT NULL DEFAULT 'F',
      reboot_daily INTEGER NOT NULL DEFAULT 0,
      reboot_time TEXT,
      prime_pod_daily INTEGER NOT NULL DEFAULT 0,
      prime_pod_time TEXT,
      led_night_mode_enabled INTEGER NOT NULL DEFAULT 0,
      led_day_brightness INTEGER NOT NULL DEFAULT 100,
      led_night_brightness INTEGER NOT NULL DEFAULT 0,
      led_night_start_time TEXT,
      led_night_end_time TEXT,
      global_max_on_hours INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE side_settings (
      side TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      away_mode INTEGER NOT NULL DEFAULT 0,
      always_on INTEGER NOT NULL DEFAULT 0,
      auto_off_enabled INTEGER NOT NULL DEFAULT 0,
      auto_off_minutes INTEGER NOT NULL DEFAULT 30,
      away_start TEXT,
      away_return TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
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
    CREATE TABLE run_once_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      set_points TEXT NOT NULL,
      wake_time TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    INSERT INTO device_settings (id) VALUES (1);
    INSERT INTO side_settings (side, name) VALUES ('left', 'Left'), ('right', 'Right');
    INSERT INTO device_state (side, is_powered) VALUES ('left', 0), ('right', 0);
  `)
  ;(biometricsSqlite as any).exec(`
    DROP TABLE IF EXISTS sleep_records;
    CREATE TABLE sleep_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      entered_bed_at INTEGER NOT NULL,
      left_bed_at INTEGER NOT NULL,
      sleep_duration_seconds INTEGER NOT NULL,
      times_exited_bed INTEGER NOT NULL DEFAULT 0,
      present_intervals TEXT,
      not_present_intervals TEXT,
      created_at INTEGER NOT NULL
    );
  `)
}

function setSideOn(side: 'left' | 'right', poweredOnAtMs: number): void {
  ;(sqlite as any)
    .prepare('UPDATE device_state SET is_powered=1, powered_on_at=? WHERE side=?')
    .run(Math.floor(poweredOnAtMs / 1000), side)
}

function setSideSettings(side: 'left' | 'right', patch: Partial<{
  autoOffEnabled: number
  autoOffMinutes: number
  alwaysOn: number
}>): void {
  const current = (sqlite as any)
    .prepare('SELECT * FROM side_settings WHERE side=?')
    .get(side)
  const merged = {
    auto_off_enabled: patch.autoOffEnabled ?? current.auto_off_enabled,
    auto_off_minutes: patch.autoOffMinutes ?? current.auto_off_minutes,
    always_on: patch.alwaysOn ?? current.always_on,
  }
  ;(sqlite as any)
    .prepare('UPDATE side_settings SET auto_off_enabled=?, auto_off_minutes=?, always_on=? WHERE side=?')
    .run(merged.auto_off_enabled, merged.auto_off_minutes, merged.always_on, side)
}

function setGlobalCap(hours: number | null): void {
  ;(sqlite as any)
    .prepare('UPDATE device_settings SET global_max_on_hours=? WHERE id=1')
    .run(hours)
}

function insertSleepRecord(side: 'left' | 'right', enteredAtMs: number, leftAtMs: number): void {
  ;(biometricsSqlite as any)
    .prepare(`
      INSERT INTO sleep_records
        (side, entered_bed_at, left_bed_at, sleep_duration_seconds, created_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    .run(
      side,
      Math.floor(enteredAtMs / 1000),
      Math.floor(leftAtMs / 1000),
      Math.max(0, Math.floor((leftAtMs - enteredAtMs) / 1000)),
      Math.floor(leftAtMs / 1000),
    )
}

function insertActiveRunOnce(side: 'left' | 'right'): void {
  ;(sqlite as any)
    .prepare(`
      INSERT INTO run_once_sessions
        (side, set_points, wake_time, expires_at, status)
      VALUES (?, '[]', '07:00', ?, 'active')
    `)
    .run(side, Math.floor(Date.now() / 1000) + 3600)
}

/**
 * Run an immediate poll and flush one microtask turn so any async
 * firePowerOff() promises settle before assertions.
 */
async function pollAndFlush(): Promise<void> {
  // startAutoOffWatcher polls synchronously on start; stopping then starting
  // again gives us a fresh poll we can flush.
  await stopAutoOffWatcher()
  startAutoOffWatcher()
  // Allow the fire-and-forget powerOffSide promise to resolve.
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

beforeEach(() => {
  setPower.mockClear()
  connect.mockClear()
  resetSchema()
})

afterEach(async () => {
  await stopAutoOffWatcher()
})

// ── ygg-8: grace-window give-up removed ──────────────────────────────────

describe('per-side auto-off (grace-window fix, ygg-8)', () => {
  it('fires when bed exit was 2h ago and side is still on (was previously skipped)', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000) // powered 3h ago
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000) // exit 2h ago

    await pollAndFlush()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('does not fire if side is already off', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    // left stays is_powered=0
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('does not fire if user returned to bed after the exit', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    // Earlier: exit 2h ago; newer: entered again 30min ago, left 1min ago? No —
    // a single latest row with enteredBedAt > leftBedAt signals currently in bed.
    insertSleepRecord('left', now - 30 * 60_000, now - 60 * 60_000) // entered 30min ago > left 60min ago = in bed

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('is suppressed by an active run-once session', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)
    insertActiveRunOnce('left')

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('is suppressed by always_on = true', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30, alwaysOn: 1 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })
})

// ── ygg-7: global wall-clock cap ─────────────────────────────────────────

describe('global auto-off cap (ygg-7)', () => {
  it('does not fire when cap is NULL (disabled)', async () => {
    const now = Date.now()
    setGlobalCap(null)
    setSideOn('left', now - 20 * 3600_000) // on for 20h
    // auto_off_enabled left at 0 to isolate the global-cap path

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('fires when a side has been on longer than the cap', async () => {
    const now = Date.now()
    setGlobalCap(1) // 1 hour
    setSideOn('left', now - 65 * 60_000) // 65 min ago

    await pollAndFlush()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('does not fire when a side has been on less than the cap', async () => {
    const now = Date.now()
    setGlobalCap(1) // 1 hour
    setSideOn('left', now - 30 * 60_000) // 30 min ago

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('is suppressed by an active run-once session', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now - 5 * 3600_000) // 5h past cap
    insertActiveRunOnce('left')

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('is suppressed by always_on = true', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now - 5 * 3600_000) // 5h past cap
    setSideSettings('left', { alwaysOn: 1 })

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips the cap if poweredOnAt is in the future (clock-sanity guard)', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now + 3600_000) // future — looks corrupted
    await pollAndFlush()
    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips the cap if poweredOnAt is more than 7 days old (stale-seed guard)', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now - 10 * 86_400_000) // 10 days ago
    await pollAndFlush()
    expect(setPower).not.toHaveBeenCalled()
  })

  it('fires even when per-side auto-off is disabled (global cap is independent)', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now - 90 * 60_000) // 90 min ago
    setSideSettings('left', { autoOffEnabled: 0 }) // per-side OFF

    await pollAndFlush()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })
})
