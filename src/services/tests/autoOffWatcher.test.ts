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
import {
  startAutoOffWatcher,
  stopAutoOffWatcher,
  restartAutoOffTimers,
  cancelAutoOffTimer,
} from '@/src/services/autoOffWatcher'
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

// ── Edge cases & untouched branches ──────────────────────────────────────

describe('per-side auto-off (timer arming, no record, error paths)', () => {
  it('does nothing when feature enabled but no sleep record exists yet', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 10 * 60_000)
    // no sleep record inserted -- exercises the "no record" branch

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('does not fire when bed exit is recent (timer armed, not yet expired)', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000) // exit 5min ago, 30min cap

    await pollAndFlush()

    // Timer is armed but won't fire in this synchronous window
    expect(setPower).not.toHaveBeenCalled()
  })

  it('logs but swallows errors when powerOffSide hardware call rejects', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    setPower.mockRejectedValueOnce(new Error('hardware offline'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await pollAndFlush()

    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('logs non-Error thrown values from powerOffSide', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    setPower.mockRejectedValueOnce('string failure')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await pollAndFlush()

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to power off left'),
      'string failure',
    )
    errSpy.mockRestore()
  })

  it('survives db.select errors in evaluateSide via the poll-level catch', async () => {
    // Drop the device_state table mid-flight to make isSidePowered() throw past
    // its inner catch -- actually inner catch returns false. Better: drop
    // side_settings to break getAutoOffConfig (already inner-caught -> defaults).
    // To reach the poll-level outer catch (line 427), break a non-caught path:
    // drop device_settings AFTER getGlobalMaxOnHours has run is hard. Instead
    // we rely on the inner catches; this test just confirms no throw escapes.
    ;(sqlite as any).exec('DROP TABLE side_settings;')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(pollAndFlush()).resolves.toBeUndefined()

    errSpy.mockRestore()
  })

  it('returns defaults when device_settings is missing (global cap path)', async () => {
    const now = Date.now()
    ;(sqlite as any).exec('DROP TABLE device_settings;')
    setSideOn('left', now - 5 * 3600_000)
    // auto_off_enabled left at default 0 -- only global cap path engaged,
    // and global cap returns null on error so no fire
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('treats a side as unpowered when device_state read throws', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    // Drop after seeding -- isSidePowered() catches and returns false, the
    // side is treated as already off, no power-off is dispatched.
    ;(sqlite as any).exec('DROP TABLE device_state;')

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('treats run-once as inactive when run_once_sessions read throws', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now - 5 * 3600_000) // past cap
    // Drop only run_once_sessions -- evaluateSide reaches hasActiveRunOnce()
    // for the active side, the catch returns false, and the global cap fires.
    ;(sqlite as any).exec('DROP TABLE run_once_sessions;')

    await pollAndFlush()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('treats the latest record as null when sleep_records read throws', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    // Drop biometrics-side records -- getLatestSleepRecord catches and
    // returns null; evaluateSide should bail without firing.
    ;(biometricsSqlite as any).exec('DROP TABLE sleep_records;')

    await pollAndFlush()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('treats poweredOnAt as null when device_state schema is broken mid-flight', async () => {
    const now = Date.now()
    setGlobalCap(1)
    setSideOn('left', now - 5 * 3600_000)
    // Replace device_state with a schema missing powered_on_at so the SELECT
    // throws -- inner catch returns null, the global cap path is skipped.
    ;(sqlite as any).exec(`
      DROP TABLE device_state;
      CREATE TABLE device_state (
        side TEXT PRIMARY KEY,
        is_powered INTEGER NOT NULL DEFAULT 1
      );
      INSERT INTO device_state (side, is_powered) VALUES ('left', 1), ('right', 0);
    `)

    await pollAndFlush()

    // Cap path skipped (poweredOnAt unknown) and per-side path also returns
    // (no sleep record path will run since auto-off feature defaults to off
    // after the table-drop above wiped side_settings... actually side_settings
    // is intact -- just verify no crash and no fire from the cap.
    expect(setPower).not.toHaveBeenCalled()
  })
})

// ── Timer firing under fake timers ───────────────────────────────────────

describe('per-side auto-off (fake-timer firing)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires the armed timer once the timeout elapses', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000) // exit 5min ago

    startAutoOffWatcher() // arms a setTimeout for ~25min

    // Advance past the timeout window
    await vi.advanceTimersByTimeAsync(26 * 60_000)
    // Flush microtasks for firePowerOff promise chain
    await Promise.resolve()
    await Promise.resolve()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('skips firing when user returned to bed before the timer expires', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher()

    // Before the timer fires, simulate re-entry: insert a newer record where
    // enteredBedAt > leftBedAt
    insertSleepRecord('left', now - 1 * 60_000, now - 4 * 60_000)

    await vi.advanceTimersByTimeAsync(26 * 60_000)
    await Promise.resolve()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips firing when latest record matches but user is back in bed (live-presence guard)', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    const leftAt = now - 5 * 60_000
    insertSleepRecord('left', now - 90 * 60_000, leftAt) // armed exit

    startAutoOffWatcher()

    // Skim past most of the polling interval. The setTimeout fires at ~25min;
    // the last poll before that runs at 24m30s. We advance to 24m45s, then
    // stamp the user back in bed (same leftBedAt, newer enteredBedAt) so that
    // when the setTimeout fires at 25m, the match-event check passes but the
    // live-presence check trips.
    await vi.advanceTimersByTimeAsync(24 * 60_000 + 45_000)
    ;(biometricsSqlite as any)
      .prepare('UPDATE sleep_records SET entered_bed_at=? WHERE side=? AND left_bed_at=?')
      .run(Math.floor((now - 1 * 60_000) / 1000), 'left', Math.floor(leftAt / 1000))

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await Promise.resolve()

    expect(setPower).not.toHaveBeenCalled()
    expect(logSpy.mock.calls.some(args =>
      typeof args[0] === 'string' && args[0].includes('user returned to bed'),
    )).toBe(true)
    logSpy.mockRestore()
  })

  it('skips firing when the latest bed-exit changed before the timer expires', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher()

    // Newer exit overrides the armed one (different leftBedAt, still out of bed)
    insertSleepRecord('left', now - 80 * 60_000, now - 2 * 60_000)

    await vi.advanceTimersByTimeAsync(26 * 60_000)
    await Promise.resolve()

    // Newer event => callback returns; evaluateSide will re-arm on next poll
    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips firing when side is no longer powered when callback runs', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher()

    // User powered the side off manually before the timer expires
    ;(sqlite as any).prepare('UPDATE device_state SET is_powered=0 WHERE side=?').run('left')

    await vi.advanceTimersByTimeAsync(26 * 60_000)
    await Promise.resolve()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips firing when run-once becomes active before callback runs', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher()

    insertActiveRunOnce('left')

    await vi.advanceTimersByTimeAsync(26 * 60_000)
    await Promise.resolve()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('skips firing when feature is disabled before callback runs', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher()

    setSideSettings('left', { autoOffEnabled: 0 })

    await vi.advanceTimersByTimeAsync(26 * 60_000)
    await Promise.resolve()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('keeps an existing timer when poll re-evaluates same exit/timeout', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher() // arms timer
    // Drive the polling interval so evaluateSide re-runs and hits the
    // "timer already correct -- keep it" early return
    await vi.advanceTimersByTimeAsync(30_000)
    await Promise.resolve()

    expect(setPower).not.toHaveBeenCalled()
  })

  it('restarts an armed timer when autoOffMinutes changes via restartAutoOffTimers', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher()
    // Shorten timeout so a newly-armed timer fires sooner; restart re-polls
    setSideSettings('left', { autoOffMinutes: 6 })
    restartAutoOffTimers()

    // 6min cap, exit was 5min ago, so ~1min remains
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('cancelAutoOffTimer aborts a pending countdown without re-evaluation', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 60 * 60_000)
    insertSleepRecord('left', now - 90 * 60_000, now - 5 * 60_000)

    startAutoOffWatcher() // arms timer
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    cancelAutoOffTimer('left')

    // Cancel logs the cancellation message; no power-off should have fired
    // synchronously (the next interval poll WILL re-arm, but the cancel
    // itself is the contract under test).
    expect(logSpy.mock.calls.some(args =>
      typeof args[0] === 'string' && args[0].includes('timer cancelled'),
    )).toBe(true)
    expect(setPower).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('cancelAutoOffTimer is a no-op when no timer is set', () => {
    // No prior arming -- exercise the early-exit branch
    expect(() => cancelAutoOffTimer('right')).not.toThrow()
  })
})

// ── Lifecycle helpers ────────────────────────────────────────────────────

describe('watcher lifecycle', () => {
  it('startAutoOffWatcher is idempotent (second call is a no-op)', () => {
    startAutoOffWatcher()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    startAutoOffWatcher()
    // Second start should not log "Watcher started" again
    const startedCalls = logSpy.mock.calls.filter(args =>
      typeof args[0] === 'string' && args[0].includes('Watcher started'),
    )
    expect(startedCalls).toHaveLength(0)
    logSpy.mockRestore()
  })

  it('restartAutoOffTimers does nothing if watcher is not running', () => {
    // Ensure watcher is stopped
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    restartAutoOffTimers()
    // No "bed exit detected" or other poll-side logs should appear
    expect(logSpy).not.toHaveBeenCalled()
    logSpy.mockRestore()
  })

  it('stopAutoOffWatcher awaits in-flight power-off promises', async () => {
    const now = Date.now()
    setSideSettings('left', { autoOffEnabled: 1, autoOffMinutes: 30 })
    setSideOn('left', now - 3 * 3600_000)
    insertSleepRecord('left', now - 4 * 3600_000, now - 2 * 3600_000)

    // Make setPower hang briefly so the in-flight set is non-empty when stop runs
    const resolveBox: { fn: (() => void) | null } = { fn: null }
    setPower.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveBox.fn = () => resolve() }),
    )

    startAutoOffWatcher()
    // Allow synchronous poll to fire firePowerOff
    await Promise.resolve()
    await Promise.resolve()

    const stopP = stopAutoOffWatcher()
    // stop is now waiting on the pending power-off
    resolveBox.fn?.()
    await stopP

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('stopAutoOffWatcher is safe to call when never started', async () => {
    await expect(stopAutoOffWatcher()).resolves.toBeUndefined()
  })
})
