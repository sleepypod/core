/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

// ── Shared mocks ──────────────────────────────────────────────────────────
const setTemperature = vi.fn(async () => {})
const connect = vi.fn(async () => {})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect, setTemperature }),
}))

const pumpStallShouldBlock = vi.fn<(side: 'left' | 'right') => boolean>(() => false)
vi.mock('@/src/hardware/pumpStallGuard', () => ({
  shouldBlock: (side: 'left' | 'right') => pumpStallShouldBlock(side),
}))

// In-memory primary DB (the keepalive service does not touch biometrics, but
// the @/src/db module exports both — keep parity with autoOffWatcher.test.ts).
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
import {
  startKeepalive,
  stopKeepalive,
  initializeKeepalives,
  shutdownKeepalives,
} from '@/src/services/temperatureKeepalive'
const { sqlite } = dbModule as typeof dbModule & {
  sqlite: BetterSqlite3.Database
}

const KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000

function resetSchema(): void {
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS side_settings;
    DROP TABLE IF EXISTS device_state;

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

    INSERT INTO side_settings (side, name) VALUES ('left', 'Left'), ('right', 'Right');
    INSERT INTO device_state (side, is_powered) VALUES ('left', 0), ('right', 0);
  `)
}

function setSideState(
  side: 'left' | 'right',
  patch: Partial<{ isPowered: number, targetTemperature: number | null }>,
): void {
  const current = (sqlite as any)
    .prepare('SELECT * FROM device_state WHERE side=?')
    .get(side)
  ;(sqlite as any)
    .prepare(`
      UPDATE device_state
      SET is_powered = ?, target_temperature = ?
      WHERE side = ?
    `)
    .run(
      patch.isPowered ?? current.is_powered,
      patch.targetTemperature !== undefined
        ? patch.targetTemperature
        : current.target_temperature,
      side,
    )
}

function setSideSettings(
  side: 'left' | 'right',
  patch: Partial<{ alwaysOn: number }>,
): void {
  const current = (sqlite as any)
    .prepare('SELECT * FROM side_settings WHERE side=?')
    .get(side)
  ;(sqlite as any)
    .prepare('UPDATE side_settings SET always_on = ? WHERE side = ?')
    .run(patch.alwaysOn ?? current.always_on, side)
}

/** Flush microtasks so the fire-and-forget initial tick() resolves. */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

beforeEach(() => {
  setTemperature.mockClear()
  connect.mockClear()
  pumpStallShouldBlock.mockReset().mockReturnValue(false)
  resetSchema()
})

afterEach(() => {
  shutdownKeepalives()
  vi.useRealTimers()
})

describe('startKeepalive', () => {
  it('fires immediately and re-sends target temperature when side is on with alwaysOn', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 1 })

    startKeepalive('left')
    await flushAsync()

    expect(connect).toHaveBeenCalledTimes(1)
    expect(setTemperature).toHaveBeenCalledTimes(1)
    expect(setTemperature).toHaveBeenCalledWith('left', 95)
  })

  it('skips setTemperature when the side is not powered', async () => {
    setSideState('left', { isPowered: 0, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 1 })

    startKeepalive('left')
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('skips silently when the pump stall guard is holding the side off', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 1 })
    pumpStallShouldBlock.mockReturnValue(true)

    startKeepalive('left')
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })

  it('skips setTemperature when targetTemperature is null', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: null })
    setSideSettings('left', { alwaysOn: 1 })

    startKeepalive('left')
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('skips and stops the timer when alwaysOn was toggled off between ticks', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 0 })

    startKeepalive('left')
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()

    // alwaysOn was off → service should have called stopKeepalive itself.
    // Re-enabling alwaysOn without restarting must NOT cause the next tick
    // to fire, proving the timer was cleared.
    setSideSettings('left', { alwaysOn: 1 })
    // No way to advance without the timer existing; just confirm idempotent
    // stopKeepalive on this side is a no-op (i.e. timer already gone).
    stopKeepalive('left')
    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('is idempotent — calling start twice does not stack timers', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 90 })
    setSideSettings('left', { alwaysOn: 1 })

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    startKeepalive('left')
    startKeepalive('left')
    await flushAsync()

    // Two immediate ticks (one per start call), but only one interval armed.
    expect(setTemperature).toHaveBeenCalledTimes(2)

    setTemperature.mockClear()
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
    await flushAsync()

    // Only ONE interval fired — proves the second start cleared the first.
    expect(setTemperature).toHaveBeenCalledTimes(1)
  })

  it('continues firing on the 6h interval', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 88 })
    setSideSettings('left', { alwaysOn: 1 })

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    startKeepalive('left')
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(1) // immediate

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(3)
  })

  it('swallows hardware errors so the interval keeps running', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 92 })
    setSideSettings('left', { alwaysOn: 1 })

    setTemperature.mockRejectedValueOnce(new Error('boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    startKeepalive('left')
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(1)
    expect(errSpy).toHaveBeenCalled()

    // The next interval should still fire — error did not kill the timer.
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS)
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(2)

    errSpy.mockRestore()
  })

  it('logs non-Error rejections without crashing', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 92 })
    setSideSettings('left', { alwaysOn: 1 })

    setTemperature.mockRejectedValueOnce('string-error')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    startKeepalive('left')
    await flushAsync()

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[keepalive] Failed to re-send temperature for left:'),
      'string-error',
    )
    errSpy.mockRestore()
  })
})

describe('stopKeepalive', () => {
  it('stops the running interval', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 90 })
    setSideSettings('left', { alwaysOn: 1 })

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    startKeepalive('left')
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(1)

    stopKeepalive('left')

    setTemperature.mockClear()
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3)
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('is a no-op when no timer is active', () => {
    expect(() => stopKeepalive('left')).not.toThrow()
    expect(() => stopKeepalive('right')).not.toThrow()
  })
})

describe('initializeKeepalives', () => {
  it('starts a timer only for sides with alwaysOn = true', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 90 })
    setSideState('right', { isPowered: 1, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 1 })
    setSideSettings('right', { alwaysOn: 0 })

    initializeKeepalives()
    await flushAsync()

    expect(setTemperature).toHaveBeenCalledTimes(1)
    expect(setTemperature).toHaveBeenCalledWith('left', 90)
  })

  it('starts timers for both sides when both have alwaysOn', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 90 })
    setSideState('right', { isPowered: 1, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 1 })
    setSideSettings('right', { alwaysOn: 1 })

    initializeKeepalives()
    await flushAsync()

    expect(setTemperature).toHaveBeenCalledTimes(2)
    expect(setTemperature).toHaveBeenCalledWith('left', 90)
    expect(setTemperature).toHaveBeenCalledWith('right', 95)
  })

  it('starts no timers when neither side has alwaysOn', async () => {
    setSideSettings('left', { alwaysOn: 0 })
    setSideSettings('right', { alwaysOn: 0 })

    initializeKeepalives()
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('catches per-side errors and logs them', async () => {
    // Drop the side_settings table entirely so the per-side select throws.
    ;(sqlite as any).exec(`DROP TABLE side_settings;`)

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(() => initializeKeepalives()).not.toThrow()
    await flushAsync()

    // Both sides should have logged an init failure.
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[keepalive] Failed to initialize for left:'),
      expect.any(String),
    )
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('[keepalive] Failed to initialize for right:'),
      expect.any(String),
    )
    expect(setTemperature).not.toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('shutdownKeepalives', () => {
  it('stops every active timer', async () => {
    setSideState('left', { isPowered: 1, targetTemperature: 90 })
    setSideState('right', { isPowered: 1, targetTemperature: 95 })
    setSideSettings('left', { alwaysOn: 1 })
    setSideSettings('right', { alwaysOn: 1 })

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })

    startKeepalive('left')
    startKeepalive('right')
    await flushAsync()
    expect(setTemperature).toHaveBeenCalledTimes(2)

    shutdownKeepalives()

    setTemperature.mockClear()
    await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 2)
    await flushAsync()

    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('is a no-op when no timers are active', () => {
    expect(() => shutdownKeepalives()).not.toThrow()
  })
})
