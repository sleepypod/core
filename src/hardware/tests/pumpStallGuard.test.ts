/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const biometricsSchema = await import('@/src/db/biometrics-schema')
  const primary = new BetterSqlite3(':memory:')
  const bio = new BetterSqlite3(':memory:')
  return {
    db: drizzle(primary, { schema }),
    biometricsDb: drizzle(bio, { schema: biometricsSchema }),
    sqlite: primary,
    biometricsSqlite: bio,
  }
})

const setPower = vi.fn(async () => {})
const setTemperature = vi.fn(async () => {})

vi.mock('@/src/hardware/sharedClient', () => ({
  getSharedHardwareClient: () => ({
    setPower,
    setTemperature,
  }),
}))

import * as dbModule from '@/src/db'
import {
  __test__,
  acknowledge,
  invalidateGuardSettingsCache,
  onFrame,
  rearm,
  rehydrate,
  reset,
  shouldBlock,
} from '../pumpStallGuard'
import { getPumpStallNotice } from '../pumpStallNotification'

const { sqlite, biometricsSqlite } = dbModule as typeof dbModule & {
  sqlite: BetterSqlite3.Database
  biometricsSqlite: BetterSqlite3.Database
}

function resetSchema(): void {
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS device_settings;
    DROP TABLE IF EXISTS device_state;
    CREATE TABLE device_settings (
      id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      temperature_unit TEXT NOT NULL DEFAULT 'F',
      reboot_daily INTEGER NOT NULL DEFAULT 0,
      reboot_time TEXT DEFAULT '03:00',
      prime_pod_daily INTEGER NOT NULL DEFAULT 0,
      prime_pod_time TEXT DEFAULT '14:00',
      led_night_mode_enabled INTEGER NOT NULL DEFAULT 0,
      led_day_brightness INTEGER NOT NULL DEFAULT 100,
      led_night_brightness INTEGER NOT NULL DEFAULT 0,
      led_night_start_time TEXT DEFAULT '22:00',
      led_night_end_time TEXT DEFAULT '07:00',
      global_max_on_hours INTEGER,
      mqtt_enabled INTEGER,
      mqtt_url TEXT,
      mqtt_username TEXT,
      mqtt_password TEXT,
      mqtt_topic_prefix TEXT,
      mqtt_ha_discovery INTEGER,
      mqtt_tls_enabled INTEGER,
      mqtt_tls_insecure INTEGER,
      homekit_enabled INTEGER NOT NULL DEFAULT 0,
      pump_stall_protection_enabled INTEGER NOT NULL DEFAULT 1,
      pump_stall_rpm_threshold INTEGER NOT NULL DEFAULT 500,
      pump_stall_dwell_samples INTEGER NOT NULL DEFAULT 2,
      pump_stall_auto_recovery_enabled INTEGER NOT NULL DEFAULT 0,
      pump_stall_recovery_rpm INTEGER NOT NULL DEFAULT 1500,
      pump_stall_recovery_samples INTEGER NOT NULL DEFAULT 3,
      autopilot_enabled INTEGER NOT NULL DEFAULT 1,
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
    INSERT INTO device_settings (id) VALUES (1);
    INSERT INTO device_state (side, is_powered, target_temperature)
      VALUES ('left', 1, 78), ('right', 1, 78);
  `)
  ;(biometricsSqlite as any).exec(`
    DROP TABLE IF EXISTS pump_alerts;
    CREATE TABLE pump_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      side TEXT,
      rpm INTEGER,
      flowrate_cd INTEGER,
      duration_seconds INTEGER,
      action TEXT NOT NULL DEFAULT 'none',
      restore_target_temperature INTEGER,
      restore_duration_seconds INTEGER,
      acknowledged_at INTEGER,
      dismissed_at INTEGER
    );
  `)
}

function setSettings(patch: Record<string, number>): void {
  const cols = Object.keys(patch).map(k => `${k} = ${patch[k]}`).join(', ')
  ;(sqlite as any).exec(`UPDATE device_settings SET ${cols} WHERE id = 1`)
}

describe('pumpStallGuard', () => {
  beforeEach(() => {
    resetSchema()
    invalidateGuardSettingsCache()
    reset()
    setPower.mockClear()
    setTemperature.mockClear()
  })
  afterEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('does not trip when expectedActive is false (side off)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await onFrame({
        side: 'left',
        rpm: 0,
        expectedActive: false,
        preStallTarget: null,
        preStallDurationSeconds: null,
      })
    }
    expect(shouldBlock('left')).toBe(false)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('trips after dwellSamples consecutive low-RPM frames', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(false)
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
    expect(setPower).toHaveBeenCalledWith('left', false)
    const notice = getPumpStallNotice('left')
    expect(notice?.rpm).toBe(100)
    expect((biometricsSqlite as any).prepare('SELECT type, side FROM pump_alerts').get()).toEqual({
      type: 'stall_left',
      side: 'left',
    })
  })

  it('does not trip when settings disable the guard', async () => {
    setSettings({ pump_stall_protection_enabled: 0 })
    invalidateGuardSettingsCache()
    for (let i = 0; i < 5; i += 1) {
      await onFrame({
        side: 'left',
        rpm: 50,
        expectedActive: true,
        preStallTarget: 78,
        preStallDurationSeconds: 28800,
      })
    }
    expect(shouldBlock('left')).toBe(false)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('clears the dwell counter on a healthy frame between low frames', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(false)
  })

  it('treats RPM exactly at the trip threshold as healthy', async () => {
    await onFrame({ side: 'left', rpm: 500, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 500, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(shouldBlock('left')).toBe(false)
    expect(setPower).not.toHaveBeenCalled()
  })

  it('refreshes cached settings at the exact five-second TTL boundary', () => {
    let now = 10_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    expect(__test__.readSettings().threshold).toBe(500)
    setSettings({ pump_stall_rpm_threshold: 777 })

    now += 4_999
    expect(__test__.readSettings().threshold).toBe(500)
    now += 1
    expect(__test__.readSettings().threshold).toBe(777)
  })

  it('uses the complete fail-safe defaults after a degraded settings read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(sqlite as any).exec('DROP TABLE device_settings')
    invalidateGuardSettingsCache()

    expect(__test__.readSettings()).toEqual({
      enabled: false,
      threshold: 500,
      dwellSamples: 2,
      autoRecoveryEnabled: false,
      recoveryRpm: 1500,
      recoverySamples: 3,
    })
    warn.mockRestore()
  })

  it('auto-recovers only when enabled and after recoverySamples healthy frames', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(false)
    expect(setPower).toHaveBeenCalledWith('left', true, 78)
    expect(setTemperature).toHaveBeenCalledWith('left', 78, 28800)
  })

  it('counts RPM exactly at recoveryRpm as a healthy frame', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    await onFrame({ side: 'left', rpm: 1500, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
    await onFrame({ side: 'left', rpm: 1500, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(shouldBlock('left')).toBe(false)
    expect(setPower).toHaveBeenCalledWith('left', true, 78)
  })

  it('does not auto-recover when auto-recovery is disabled', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    setPower.mockClear()
    setTemperature.mockClear()
    for (let i = 0; i < 5; i += 1) {
      await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    }
    expect(shouldBlock('left')).toBe(true)
    expect(setPower).not.toHaveBeenCalled()
    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('acknowledge returns the pre-stall snapshot and clears the guard', async () => {
    await onFrame({ side: 'right', rpm: 100, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'right', rpm: 100, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 28800 })
    expect(shouldBlock('right')).toBe(true)

    const { restore, alertId } = acknowledge('right')
    expect(restore).toEqual({ targetTemperature: 80, durationSeconds: 28800 })
    expect(alertId).toBeGreaterThan(0)
    expect(shouldBlock('right')).toBe(false)
    expect(getPumpStallNotice('right')).toBeNull()
  })

  it('rearm restores blocked state, snapshot, and notice', () => {
    rearm('left', {
      alertId: 9,
      restore: { targetTemperature: 77, durationSeconds: 3600 },
      trippedAt: 1_720_000_111_000,
      rpm: 42,
    })

    expect(shouldBlock('left')).toBe(true)
    const state = __test__.getState().left
    expect(state.activeAlertId).toBe(9)
    expect(state.trippedAt).toBe(1_720_000_111_000)
    expect(state.preStall).toEqual({ targetTemperature: 77, durationSeconds: 3600 })
    expect(getPumpStallNotice('left')).toEqual({
      alertId: 9,
      trippedAt: 1_720_000_111,
      rpm: 42,
      restore: { targetTemperature: 77, durationSeconds: 3600 },
    })
  })

  it('rearm falls back to now and zeroed notice fields when trip metadata is unknown', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_720_000_500_000)

    rearm('right', { alertId: null, restore: null })

    expect(shouldBlock('right')).toBe(true)
    expect(__test__.getState().right.activeAlertId).toBeNull()
    expect(getPumpStallNotice('right')).toEqual({
      alertId: 0,
      trippedAt: 1_720_000_500,
      rpm: 0,
      restore: null,
    })
  })

  it('reset() clears guard and notification', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    reset('left')
    expect(shouldBlock('left')).toBe(false)
    expect(getPumpStallNotice('left')).toBeNull()
  })

  it('reset(side) preserves the other side guard and notification', async () => {
    for (const side of ['left', 'right'] as const) {
      await onFrame({ side, rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
      await onFrame({ side, rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    }

    reset('left')

    expect(shouldBlock('left')).toBe(false)
    expect(getPumpStallNotice('left')).toBeNull()
    expect(shouldBlock('right')).toBe(true)
    expect(getPumpStallNotice('right')).not.toBeNull()
  })

  it('fails safe-off and warns when settings read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(sqlite as any).exec(`DROP TABLE device_settings`)
    invalidateGuardSettingsCache()

    // Enabled defaults false on a degraded read — a power-cutting feature must
    // not arm on missing data, even though threshold/dwell defaults still apply.
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(false)
    expect(setPower).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to read settings'),
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('resets healthy counter when an already-blocked side dips below recoveryRpm', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 3 })
    invalidateGuardSettingsCache()

    // Trip
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)

    // Two healthy, then one sub-recovery frame — counter must reset.
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
    expect(setPower).not.toHaveBeenCalledWith('left', true, expect.any(Number))

    // Now three back-to-back healthy frames recover.
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
    expect(setPower).not.toHaveBeenCalledWith('left', true, expect.any(Number))
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(false)
  })

  it('falls back to device_state target when frame carries no preStall snapshot', async () => {
    ;(sqlite as any).exec(`UPDATE device_state SET target_temperature = 82 WHERE side = 'left'`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    const notice = getPumpStallNotice('left')
    expect(notice?.restore).toEqual({ targetTemperature: 82, durationSeconds: 28800 })
  })

  it('does not warn when no device_state snapshot row exists', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(sqlite as any).exec('DELETE FROM device_state WHERE side = \'left\'')

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(shouldBlock('left')).toBe(true)
    expect(warn.mock.calls.some(([message]) => String(message).includes('snapshot read failed'))).toBe(false)
    warn.mockRestore()
  })

  it('persists the exact right-side trip snapshot, state, notice, and log', async () => {
    const now = 1_720_000_123_987
    vi.spyOn(Date, 'now').mockReturnValue(now)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await onFrame({ side: 'right', rpm: 499, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 1234 })
    await onFrame({ side: 'right', rpm: 499, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 1234 })

    expect((sqlite as any).prepare('SELECT is_powered, powered_on_at, target_temperature FROM device_state WHERE side = ?').get('right')).toEqual({
      is_powered: 0,
      powered_on_at: null,
      target_temperature: null,
    })
    expect((biometricsSqlite as any).prepare('SELECT timestamp, type, side, rpm, action, restore_target_temperature, restore_duration_seconds FROM pump_alerts').get()).toEqual({
      timestamp: 1_720_000_123,
      type: 'stall_right',
      side: 'right',
      rpm: 499,
      action: 'power_off',
      restore_target_temperature: 80,
      restore_duration_seconds: 1234,
    })
    expect(getPumpStallNotice('right')).toEqual(expect.objectContaining({
      trippedAt: 1_720_000_123,
      rpm: 499,
      restore: { targetTemperature: 80, durationSeconds: 1234 },
    }))
    expect(warning).toHaveBeenCalledWith('[pumpStallGuard] tripped right at 499 rpm — powering off until acknowledged')
    warning.mockRestore()
  })

  it('warns when device_state snapshot read fails inside trip()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(sqlite as any).exec(`DROP TABLE device_state`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('device_state snapshot read failed'),
      expect.anything(),
    )
    expect(shouldBlock('left')).toBe(true) // trip still proceeds
    warn.mockRestore()
  })

  it('logs and continues when setPower throws during trip', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setPower.mockRejectedValueOnce(new Error('hw down'))

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(shouldBlock('left')).toBe(true) // guard still flips
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('hardware power-off failed'),
      expect.anything(),
    )
    err.mockRestore()
  })

  it('retries a failed trip-time cutoff on subsequent frames until it succeeds', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPower.mockRejectedValueOnce(new Error('hw down'))

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
    expect(__test__.getState().left.cutoffPending).toBe(true)

    // First retry also fails — warn per retry, stay pending.
    setPower.mockRejectedValueOnce(new Error('still down'))
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(warn).toHaveBeenCalledWith('[pumpStallGuard] cutoff retry for left failed:', 'still down')
    expect(__test__.getState().left.cutoffPending).toBe(true)

    // Second retry succeeds and stops.
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(setPower).toHaveBeenCalledTimes(3)
    expect(setPower).toHaveBeenLastCalledWith('left', false)
    expect(__test__.getState().left.cutoffPending).toBe(false)

    // No further retries once the cutoff is confirmed sent.
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(setPower).toHaveBeenCalledTimes(3)
    err.mockRestore()
    warn.mockRestore()
  })

  it('does not retry the cutoff when the trip-time power-off succeeded', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(__test__.getState().left.cutoffPending).toBe(false)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(setPower).toHaveBeenCalledTimes(1)
  })

  it('warns when device_state update fails after a trip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Trip with valid schema, then drop device_state mid-trip via a fresh trip.
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    ;(sqlite as any).exec(`DROP TABLE device_state`)
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('device_state update failed'),
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('logs when pump_alerts insert fails and leaves activeAlertId null', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(biometricsSqlite as any).exec(`DROP TABLE pump_alerts`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('pump_alerts insert failed'),
      expect.anything(),
    )
    const { alertId } = acknowledge('left')
    expect(alertId).toBeNull()
    err.mockRestore()
  })

  it('auto-recover with no snapshot resets the guard without re-energizing', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    // Clear device_state target so the trip captures no snapshot.
    ;(sqlite as any).exec(`UPDATE device_state SET target_temperature = NULL WHERE side = 'left'`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    expect(shouldBlock('left')).toBe(true)
    setPower.mockClear()
    setTemperature.mockClear()

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(shouldBlock('left')).toBe(false) // reset() cleared it
    expect(setPower).not.toHaveBeenCalled()
    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('aborts auto-recover and logs when hardware call throws', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    setPower.mockRejectedValueOnce(new Error('hw down'))

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('auto-recover hardware call failed'),
      expect.anything(),
    )
    expect(shouldBlock('left')).toBe(true) // stayed blocked because recovery aborted
    err.mockRestore()
  })

  it('warns when device_state restore fails during auto-recover', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    ;(sqlite as any).exec(`DROP TABLE device_state`)
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('device_state restore failed'),
      expect.anything(),
    )
    warn.mockRestore()
  })

  it('warns when alert update fails during auto-recover', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    // Drop the alerts table so the auto-recover update throws.
    ;(biometricsSqlite as any).exec(`DROP TABLE pump_alerts`)

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('alert update failed'),
      expect.anything(),
    )
    expect(shouldBlock('left')).toBe(false) // recovery still completes
    warn.mockRestore()
  })

  it('logs the raw value when a non-Error escapes a catch handler', async () => {
    // Covers the `err instanceof Error ? err.message : err` ternary on every
    // catch site in trip() and autoRecover() by throwing plain strings.
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    const origSelect = (dbModule.db as any).select.bind(dbModule.db)
    // String throw from settings read.
    ;(dbModule.db as any).select = () => {
      throw 'settings-string-err'
    }
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('failed to read settings'),
      'settings-string-err',
    )
    ;(dbModule.db as any).select = origSelect
    invalidateGuardSettingsCache()
    reset()
    warn.mockClear()

    // Warm the settings cache so readSettings doesn't trigger the next throw.
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    reset()

    // String throw from device_state snapshot read on a no-preStall trip.
    let throws = 1
    ;(dbModule.db as any).select = (...args: unknown[]) => {
      if (throws-- > 0) throw 'snapshot-string-err'
      return origSelect(...args)
    }
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('device_state snapshot read failed'),
      'snapshot-string-err',
    )
    ;(dbModule.db as any).select = origSelect

    // setPower throws a non-Error during trip.
    reset()
    setPower.mockClear()
    setPower.mockImplementationOnce(() => {
      throw 'setpower-string-err'
    })
    err.mockClear()
    await onFrame({ side: 'right', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'right', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('hardware power-off failed'),
      'setpower-string-err',
    )

    // device_state update throws a non-Error after trip.
    reset()
    const origUpdate = (dbModule.db as any).update.bind(dbModule.db)
    ;(dbModule.db as any).update = () => {
      throw 'dsupdate-string-err'
    }
    warn.mockClear()
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('device_state update failed'),
      'dsupdate-string-err',
    )
    ;(dbModule.db as any).update = origUpdate

    // pump_alerts insert throws a non-Error.
    reset()
    const origBioInsert = (dbModule.biometricsDb as any).insert.bind(dbModule.biometricsDb)
    ;(dbModule.biometricsDb as any).insert = () => {
      throw 'bio-string-err'
    }
    err.mockClear()
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('pump_alerts insert failed'),
      'bio-string-err',
    )
    ;(dbModule.biometricsDb as any).insert = origBioInsert

    warn.mockRestore()
    err.mockRestore()
  })

  it('logs raw value when auto-recover paths throw non-Error values', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Trip first.
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    // setPower throws a non-Error during auto-recover.
    setPower.mockImplementationOnce(() => {
      throw 'recover-string-err'
    })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('auto-recover hardware call failed'),
      'recover-string-err',
    )

    // device_state restore throws a non-Error.
    reset()
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    const origUpdate = (dbModule.db as any).update.bind(dbModule.db)
    let throws = 1
    ;(dbModule.db as any).update = (...args: unknown[]) => {
      if (throws-- > 0) throw 'recover-update-err'
      return origUpdate(...args)
    }
    warn.mockClear()
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('device_state restore failed'),
      'recover-update-err',
    )
    ;(dbModule.db as any).update = origUpdate

    // Alert update throws a non-Error.
    reset()
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    const origBioUpdate = (dbModule.biometricsDb as any).update.bind(dbModule.biometricsDb)
    ;(dbModule.biometricsDb as any).update = () => {
      throw 'alert-update-err'
    }
    warn.mockClear()
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('alert update failed'),
      'alert-update-err',
    )
    ;(dbModule.biometricsDb as any).update = origBioUpdate

    warn.mockRestore()
    err.mockRestore()
  })

  it('falls back alertId to 0 when pump_alerts insert returns no row', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const origBioInsert = (dbModule.biometricsDb as any).insert.bind(dbModule.biometricsDb)
    ;(dbModule.biometricsDb as any).insert = () => ({
      values: () => ({
        returning: () => ({
          all: () => [], // empty — exercises the `?? 0` fallback at L286
        }),
      }),
    })

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(shouldBlock('left')).toBe(true)
    const { alertId } = acknowledge('left')
    expect(alertId).toBeNull()
    expect(err).not.toHaveBeenCalledWith(expect.stringContaining('pump_alerts insert failed'), expect.anything())
    ;(dbModule.biometricsDb as any).insert = origBioInsert
    err.mockRestore()
  })

  it('skips the alert update during auto-recover when activeAlertId is null', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    // Force insert to fail so activeAlertId remains null.
    const origBioInsert = (dbModule.biometricsDb as any).insert.bind(dbModule.biometricsDb)
    ;(dbModule.biometricsDb as any).insert = () => {
      throw new Error('insert fail')
    }

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    ;(dbModule.biometricsDb as any).insert = origBioInsert

    // Spy on biometricsDb.update so we can prove it is NOT called during recover.
    const updateSpy = vi.spyOn(dbModule.biometricsDb, 'update')

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

    expect(shouldBlock('left')).toBe(false)
    expect(updateSpy).not.toHaveBeenCalled()
    updateSpy.mockRestore()
    warn.mockRestore()
    err.mockRestore()
  })

  it('persists exact recovered device and alert state before clearing the guard', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 79, preStallDurationSeconds: 4321 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 79, preStallDurationSeconds: 4321 })
    await onFrame({ side: 'left', rpm: 1500, expectedActive: true, preStallTarget: 79, preStallDurationSeconds: 4321 })
    await onFrame({ side: 'left', rpm: 1500, expectedActive: true, preStallTarget: 79, preStallDurationSeconds: 4321 })

    expect((sqlite as any).prepare('SELECT is_powered, target_temperature FROM device_state WHERE side = ?').get('left')).toEqual({
      is_powered: 1,
      target_temperature: 79,
    })
    const alert = (biometricsSqlite as any).prepare('SELECT action, acknowledged_at FROM pump_alerts').get()
    expect(alert.action).toBe('auto_recovered')
    expect(alert.acknowledged_at).toBeTypeOf('number')
    expect(log).toHaveBeenCalledWith('[pumpStallGuard] auto-recovered left')
    log.mockRestore()
  })

  describe('rehydrate', () => {
    function insertAlert(row: {
      side: 'left' | 'right'
      timestamp?: number
      rpm?: number | null
      action?: string
      restoreTarget?: number | null
      restoreDuration?: number | null
      acknowledgedAt?: number | null
      dismissedAt?: number | null
    }): number {
      const result = (biometricsSqlite as any).prepare(`
        INSERT INTO pump_alerts (timestamp, type, side, rpm, action, restore_target_temperature, restore_duration_seconds, acknowledged_at, dismissed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.timestamp ?? 1_720_000_000,
        row.side === 'left' ? 'stall_left' : 'stall_right',
        row.side,
        row.rpm === undefined ? 120 : row.rpm,
        row.action ?? 'power_off',
        row.restoreTarget === undefined ? 78 : row.restoreTarget,
        row.restoreDuration === undefined ? 28800 : row.restoreDuration,
        row.acknowledgedAt ?? null,
        row.dismissedAt ?? null,
      )
      return Number(result.lastInsertRowid)
    }

    it('restores blocked state, snapshot, and notice from an active power_off row', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const id = insertAlert({ side: 'left', timestamp: 1_720_000_050, rpm: 90, restoreTarget: 81, restoreDuration: 5400 })

      rehydrate()

      expect(shouldBlock('left')).toBe(true)
      expect(shouldBlock('right')).toBe(false)
      const state = __test__.getState().left
      expect(state.activeAlertId).toBe(id)
      expect(state.trippedAt).toBe(1_720_000_050_000)
      expect(state.preStall).toEqual({ targetTemperature: 81, durationSeconds: 5400 })
      expect(getPumpStallNotice('left')).toEqual({
        alertId: id,
        trippedAt: 1_720_000_050,
        rpm: 90,
        restore: { targetTemperature: 81, durationSeconds: 5400 },
      })
      expect(warn).toHaveBeenCalledWith(`[pumpStallGuard] rehydrated active stall for left from alert ${id} — blocked until acknowledged`)
      // A rehydrated block behaves like a live one: acknowledge clears it
      // and hands the persisted snapshot back for restoration.
      const { restore, alertId } = acknowledge('left')
      expect(alertId).toBe(id)
      expect(restore).toEqual({ targetTemperature: 81, durationSeconds: 5400 })
      warn.mockRestore()
    })

    it('picks the newest row by timestamp then id for same-second rows', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      insertAlert({ side: 'left', timestamp: 1_720_000_010 })
      const sameSecondOlder = insertAlert({ side: 'left', timestamp: 1_720_000_099 })
      const sameSecondNewer = insertAlert({ side: 'left', timestamp: 1_720_000_099 })
      expect(sameSecondNewer).toBeGreaterThan(sameSecondOlder)

      rehydrate()

      expect(__test__.getState().left.activeAlertId).toBe(sameSecondNewer)
      warn.mockRestore()
    })

    it('skips entirely when stall protection is disabled', () => {
      insertAlert({ side: 'left' })
      setSettings({ pump_stall_protection_enabled: 0 })
      invalidateGuardSettingsCache()

      rehydrate()

      expect(shouldBlock('left')).toBe(false)
      expect(getPumpStallNotice('left')).toBeNull()
    })

    it('ignores acknowledged, dismissed, and non-power_off rows', () => {
      insertAlert({ side: 'left', acknowledgedAt: 1_720_000_100 })
      insertAlert({ side: 'left', dismissedAt: 1_720_000_100 })
      insertAlert({ side: 'left', action: 'warned' })

      rehydrate()

      expect(shouldBlock('left')).toBe(false)
      expect(getPumpStallNotice('left')).toBeNull()
    })

    it('rehydrates with a null snapshot and zero rpm when the row carries none', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const id = insertAlert({ side: 'right', rpm: null, restoreTarget: null, restoreDuration: null })

      rehydrate()

      expect(shouldBlock('right')).toBe(true)
      expect(__test__.getState().right.preStall).toBeNull()
      expect(getPumpStallNotice('right')).toEqual(expect.objectContaining({ alertId: id, rpm: 0, restore: null }))
      warn.mockRestore()
    })

    it('does not disturb a side that is already blocked in memory', async () => {
      await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
      await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
      const liveAlertId = __test__.getState().left.activeAlertId
      insertAlert({ side: 'left', timestamp: 1_700_000_000 })

      rehydrate()

      expect(__test__.getState().left.activeAlertId).toBe(liveAlertId)
    })

    it('warns and continues when the rehydration read fails', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      ;(biometricsSqlite as any).exec('DROP TABLE pump_alerts')

      expect(() => rehydrate()).not.toThrow()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('rehydration read failed'),
        expect.anything(),
      )
      expect(shouldBlock('left')).toBe(false)
      warn.mockRestore()
    })
  })
})
