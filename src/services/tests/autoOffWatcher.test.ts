/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { OccupancyResult } from '@/src/lib/occupancy'

// ── Shared mocks ──────────────────────────────────────────────────────────
const setPower = vi.fn(async () => {})
const connect = vi.fn(async () => {})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect, setPower }),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: vi.fn(),
}))

vi.mock('@/src/hardware/deviceStateSync', () => ({
  markSideMutated: vi.fn(),
}))

// Live occupancy is the presence source (replaces sleep_records). Per-side
// result is read from this mutable map so each test can shape presence.
let mockOccupancy: Record<'left' | 'right', OccupancyResult>

function occ(occupied: boolean, available: boolean): OccupancyResult {
  return {
    occupied,
    available,
    movement: { active: occupied, peakScore: occupied ? 660 : 0 },
    level: {
      active: occupied,
      deviation: available ? (occupied ? 999 : 0) : null,
      threshold: available ? 500 : null,
      ageMs: available ? 100 : null,
    },
  }
}

vi.mock('@/src/lib/occupancy', () => ({
  getOccupancy: (side: 'left' | 'right') => mockOccupancy[side],
}))

// In-memory primary DB — a real sqlite so `where(side)` actually filters.
vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const primary = new BetterSqlite3(':memory:')
  primary.pragma('foreign_keys = ON')
  return {
    db: drizzle(primary, { schema }),
    sqlite: primary,
    closeDatabase: vi.fn(),
  }
})

import * as dbModule from '@/src/db'
import {
  startAutoOffWatcher,
  stopAutoOffWatcher,
  restartAutoOffTimers,
  cancelAutoOffTimer,
} from '@/src/services/autoOffWatcher'

const { sqlite } = dbModule as typeof dbModule & { sqlite: BetterSqlite3.Database }

const POLL_MS = 30_000

function resetSchema(): void {
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
    INSERT INTO side_settings (side, name, auto_off_enabled, auto_off_minutes)
      VALUES ('left', 'Left', 1, 30), ('right', 'Right', 1, 30);
    INSERT INTO device_state (side, is_powered) VALUES ('left', 0), ('right', 0);
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
  ;(sqlite as any)
    .prepare('UPDATE side_settings SET auto_off_enabled=?, auto_off_minutes=?, always_on=? WHERE side=?')
    .run(
      patch.autoOffEnabled ?? current.auto_off_enabled,
      patch.autoOffMinutes ?? current.auto_off_minutes,
      patch.alwaysOn ?? current.always_on,
      side,
    )
}

function setGlobalCap(hours: number | null): void {
  ;(sqlite as any)
    .prepare('UPDATE device_settings SET global_max_on_hours=? WHERE id=1')
    .run(hours)
}

function insertActiveRunOnce(side: 'left' | 'right'): void {
  ;(sqlite as any)
    .prepare(`
      INSERT INTO run_once_sessions (side, set_points, wake_time, expires_at, status)
      VALUES (?, '[]', '07:00', ?, 'active')
    `)
    .run(side, Math.floor(Date.now() / 1000) + 3600)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
  setPower.mockClear()
  connect.mockClear()
  resetSchema()
  // Default: left powered now, presence available + empty.
  setSideOn('left', Date.now())
  mockOccupancy = { left: occ(false, true), right: occ(false, true) }
})

afterEach(async () => {
  await stopAutoOffWatcher()
  vi.useRealTimers()
})

describe('autoOffWatcher — live presence', () => {
  it('powers off a side that is reliably empty past the timeout', async () => {
    startAutoOffWatcher() // poll@0 stamps emptySince
    expect(setPower).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('does NOT power off before the timeout elapses', async () => {
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('does NOT power off while the bed is occupied, however long', async () => {
    mockOccupancy.left = occ(true, true)
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(90 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('resets the countdown when the occupant returns mid-timeout', async () => {
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(20 * 60_000) // empty 20min
    mockOccupancy.left = occ(true, true) // back in bed
    await vi.advanceTimersByTimeAsync(POLL_MS) // poll observes occupied → reset
    mockOccupancy.left = occ(false, true) // leaves again
    await vi.advanceTimersByTimeAsync(20 * 60_000) // only 20min since reset
    expect(setPower).not.toHaveBeenCalled()
  })
})

describe('autoOffWatcher — fail-safe on unsensable presence', () => {
  it('does NOT power off when presence sensing is unavailable', async () => {
    mockOccupancy.left = occ(false, false) // empty-looking but unsensable
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(120 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('regression (sleepypod-core-64): never reaps a just-powered side without calibration', async () => {
    mockOccupancy.left = occ(false, false)
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(35 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })
})

describe('autoOffWatcher — exemptions', () => {
  it('skips a side that is already off', async () => {
    ;(sqlite as any).prepare('UPDATE device_state SET is_powered=0, powered_on_at=NULL WHERE side=?').run('left')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips alwaysOn sides', async () => {
    setSideSettings('left', { alwaysOn: 1 })
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips sides with an active run-once session', async () => {
    insertActiveRunOnce('left')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('does not run the per-side timer when autoOffEnabled is false', async () => {
    setSideSettings('left', { autoOffEnabled: 0 })
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })
})

describe('autoOffWatcher — global wall-clock cap', () => {
  it('fires even when presence is unsensable', async () => {
    setGlobalCap(8)
    mockOccupancy.left = occ(false, false)
    setSideOn('left', Date.now() - 9 * 3600_000) // 9h ago, past 8h cap
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('does not fire before the cap is exceeded', async () => {
    setGlobalCap(8)
    mockOccupancy.left = occ(true, true) // occupied → per-side path won't fire
    setSideOn('left', Date.now() - 2 * 3600_000) // 2h ago
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('treats a future powered_on_at as suspicious and skips', async () => {
    setGlobalCap(8)
    mockOccupancy.left = occ(true, true)
    setSideOn('left', Date.now() + 3600_000) // 1h in the future
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(POLL_MS)
    expect(setPower).not.toHaveBeenCalled()
  })
})

describe('autoOffWatcher — lifecycle', () => {
  it('startAutoOffWatcher is idempotent', async () => {
    startAutoOffWatcher()
    startAutoOffWatcher() // no-op
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(setPower).toHaveBeenCalledTimes(1)
  })

  it('stopAutoOffWatcher is safe when never started', async () => {
    await expect(stopAutoOffWatcher()).resolves.toBeUndefined()
  })

  it('restartAutoOffTimers does nothing if watcher is not running', () => {
    expect(() => restartAutoOffTimers()).not.toThrow()
    expect(setPower).not.toHaveBeenCalled()
  })

  it('restartAutoOffTimers resets the countdown so it starts fresh', async () => {
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(20 * 60_000) // empty 20min
    restartAutoOffTimers() // resets emptySince
    await vi.advanceTimersByTimeAsync(20 * 60_000) // only 20min since reset
    expect(setPower).not.toHaveBeenCalled()
  })
})

describe('autoOffWatcher — cancelAutoOffTimer', () => {
  it('resets a pending countdown so a later empty period starts fresh', async () => {
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    cancelAutoOffTimer('left') // scheduled power-on aborts the countdown
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('is a no-op when no countdown is set', () => {
    expect(() => cancelAutoOffTimer('right')).not.toThrow()
  })
})
