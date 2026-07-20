/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'
import type { OccupancyResult } from '@/src/lib/occupancy'

// ── Shared mocks ──────────────────────────────────────────────────────────
const setPower = vi.fn(async () => {})
const connect = vi.fn(async () => {})
const broadcastMutationStatus = vi.fn()
const markSideMutated = vi.fn()

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect, setPower }),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: (...args: unknown[]) => broadcastMutationStatus(...args),
}))

vi.mock('@/src/hardware/deviceStateSync', () => ({
  markSideMutated: (...args: unknown[]) => markSideMutated(...args),
}))

// Live occupancy is the presence source (replaces sleep_records). Per-side
// result is read from this mutable map so each test can shape presence.
let mockOccupancy: Record<'left' | 'right', OccupancyResult>
let occupancyFailure: unknown = null

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
  getOccupancy: (side: 'left' | 'right') => {
    if (occupancyFailure !== null) throw occupancyFailure
    return mockOccupancy[side]
  },
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
  vi.restoreAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-06-01T00:00:00Z'))
  setPower.mockClear()
  connect.mockClear()
  broadcastMutationStatus.mockClear()
  markSideMutated.mockClear()
  occupancyFailure = null
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

  it('powers off at the exact configured timeout boundary', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    startAutoOffWatcher()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('logs and publishes the exact successful power-off effects', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOffWatcher()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(connect).toHaveBeenCalledOnce()
    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(markSideMutated).toHaveBeenCalledWith('left')
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
    expect(log).toHaveBeenCalledWith('[auto-off] Powered off left side (no presence detected)')
    const state = (sqlite as any)
      .prepare('SELECT is_powered, powered_on_at, target_temperature FROM device_state WHERE side=?')
      .get('left')
    expect(state).toEqual({ is_powered: 0, powered_on_at: null, target_temperature: null })
  })

  it('continues publishing after a best-effort DB sync failure', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    setPower.mockImplementationOnce(async () => {
      ;(sqlite as any).exec('DROP TABLE device_state')
    })
    startAutoOffWatcher()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(markSideMutated).toHaveBeenCalledWith('left')
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
  })

  it('logs hardware failures and does not publish a false off state', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    connect.mockRejectedValueOnce(new Error('offline'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    startAutoOffWatcher()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(error).toHaveBeenCalledWith('[auto-off] Failed to power off left:', 'offline')
    expect(broadcastMutationStatus).not.toHaveBeenCalled()
    expect(markSideMutated).not.toHaveBeenCalled()
  })

  it('logs the countdown start with the configured timeout', () => {
    setSideSettings('left', { autoOffMinutes: 45 })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    startAutoOffWatcher()

    expect(log).toHaveBeenCalledWith('[auto-off] left: bed empty, auto-off in 45min if still empty')
  })

  it('logs the elapsed empty seconds when the timeout fires', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOffWatcher()

    await vi.advanceTimersByTimeAsync(60_000)

    expect(log).toHaveBeenCalledWith(
      '[auto-off] left: empty for 60s (past 1min timeout), powering off',
    )
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

  it('treats a thrown occupancy read as unsensable', async () => {
    occupancyFailure = new Error('sensor unavailable')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
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

describe('autoOffWatcher — unreadable state falls back to standing down', () => {
  it('treats a side with no device_state row as unpowered', async () => {
    ;(sqlite as any).prepare('DELETE FROM device_state WHERE side=?').run('left')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('treats an unreadable device_state table as unpowered', async () => {
    ;(sqlite as any).exec('DROP TABLE device_state')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('does not exempt a side when the run-once table is unreadable', async () => {
    ;(sqlite as any).exec('DROP TABLE run_once_sessions')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('leaves auto-off disabled for a side with no settings row', async () => {
    ;(sqlite as any).exec('DELETE FROM side_settings')
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('does not treat a side with no settings row as always-on', async () => {
    ;(sqlite as any).exec('DELETE FROM side_settings')
    setGlobalCap(1)
    setSideOn('left', Date.now() - 2 * 3600_000)

    startAutoOffWatcher()
    await vi.runAllTicks()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })
})

describe('autoOffWatcher — per-side config lookup', () => {
  function seedSideSettings(first: 'left' | 'right', enabledSide: 'left' | 'right'): void {
    const second = first === 'left' ? 'right' : 'left'
    ;(sqlite as any).exec('DELETE FROM side_settings')
    for (const side of [first, second]) {
      ;(sqlite as any)
        .prepare(`
          INSERT INTO side_settings (side, name, auto_off_enabled, auto_off_minutes)
          VALUES (?, ?, ?, 30)
        `)
        .run(side, side, side === enabledSide ? 1 : 0)
    }
  }

  it('reads left config from the left row even when right is stored first', async () => {
    seedSideSettings('right', 'left')

    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(31 * 60_000)

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('reads right config from the right row, not the first row', async () => {
    seedSideSettings('left', 'right')
    setSideOn('right', Date.now())

    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(31 * 60_000)

    expect(setPower).toHaveBeenCalledWith('right', false)
    expect(setPower).toHaveBeenCalledTimes(1)
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

  it('does not fire at the exact cap boundary because the limit is strictly exceeded', () => {
    setGlobalCap(8)
    mockOccupancy.left = occ(true, true)
    setSideOn('left', Date.now() - 8 * 3600_000)

    startAutoOffWatcher()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('fires one second beyond the global cap and logs the exact reason', async () => {
    setGlobalCap(8)
    mockOccupancy.left = occ(true, true)
    setSideOn('left', Date.now() - 8 * 3600_000 - 1_000)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    startAutoOffWatcher()
    await vi.runAllTicks()

    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(log).toHaveBeenCalledWith(
      '[auto-off] left: global max-on cap exceeded (8h), powering off',
    )
  })

  it.each([null, 0, -1])('disables the global cap for %s', (hours) => {
    setGlobalCap(hours)
    mockOccupancy.left = occ(true, true)
    setSideOn('left', Date.now() - 48 * 3600_000)

    startAutoOffWatcher()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('accepts exactly seven days of elapsed time as sane', async () => {
    setGlobalCap(1)
    mockOccupancy.left = occ(true, true)
    setSideOn('left', Date.now() - 7 * 86_400_000)

    startAutoOffWatcher()
    await vi.runAllTicks()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('rejects elapsed time beyond seven days as suspicious', () => {
    setGlobalCap(1)
    mockOccupancy.left = occ(true, true)
    setSideOn('left', Date.now() - 7 * 86_400_000 - 1_000)

    startAutoOffWatcher()

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
    const interval = vi.spyOn(globalThis, 'setInterval')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOffWatcher()
    startAutoOffWatcher() // no-op
    expect(interval).toHaveBeenCalledOnce()
    expect(log.mock.calls.filter(call => call[0] === '[auto-off] Watcher started (poll every 30s)')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    expect(setPower).toHaveBeenCalledTimes(1)
  })

  it('stopAutoOffWatcher is safe when never started', async () => {
    const clear = vi.spyOn(globalThis, 'clearInterval')
    await expect(stopAutoOffWatcher()).resolves.toBeUndefined()
    expect(clear).not.toHaveBeenCalled()
  })

  it('restartAutoOffTimers does nothing if watcher is not running', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(() => restartAutoOffTimers()).not.toThrow()
    expect(log).not.toHaveBeenCalled() // no poll ran, so no countdown was stamped
    expect(setPower).not.toHaveBeenCalled()
  })

  it('restartAutoOffTimers resets the countdown so it starts fresh', async () => {
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(20 * 60_000) // empty 20min
    restartAutoOffTimers() // resets emptySince
    await vi.advanceTimersByTimeAsync(20 * 60_000) // only 20min since reset
    expect(setPower).not.toHaveBeenCalled()
  })

  it('stop waits for an in-flight power-off and logs its exact count', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    let release: () => void = () => {}
    setPower.mockImplementationOnce(() => new Promise<void>((resolve) => {
      release = resolve
    }))
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60_000)

    let stopped = false
    const stop = stopAutoOffWatcher().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    expect(log).toHaveBeenCalledWith('[auto-off] Waiting for 1 in-flight power-off(s)...')

    release()
    await stop
    expect(stopped).toBe(true)
    expect(log).toHaveBeenCalledWith('[auto-off] Watcher stopped')
  })

  it('does not announce a wait once a power-off has settled', async () => {
    setSideSettings('left', { autoOffMinutes: 1 })
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(setPower).toHaveBeenCalledWith('left', false)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await stopAutoOffWatcher()

    expect(log).toHaveBeenCalledWith('[auto-off] Watcher stopped')
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('in-flight power-off'))
  })

  it('isolates and names an unexpected per-side evaluation error', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Date, 'now').mockImplementationOnce(() => {
      throw new Error('clock failed')
    })

    startAutoOffWatcher()

    expect(error).toHaveBeenCalledWith('[auto-off] Error evaluating left:', 'clock failed')
  })
})

describe('autoOffWatcher — cancelAutoOffTimer', () => {
  it('resets a pending countdown so a later empty period starts fresh', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOffWatcher()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    cancelAutoOffTimer('left') // scheduled power-on aborts the countdown
    expect(log).toHaveBeenCalledWith('[auto-off] left: countdown cancelled (scheduled power-on)')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('is a no-op when no countdown is set', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(() => cancelAutoOffTimer('right')).not.toThrow()
    expect(log).not.toHaveBeenCalled()
  })
})
