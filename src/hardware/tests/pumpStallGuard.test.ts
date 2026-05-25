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
  acknowledge,
  invalidateGuardSettingsCache,
  onFrame,
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

  it('reset() clears guard and notification', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    reset('left')
    expect(shouldBlock('left')).toBe(false)
    expect(getPumpStallNotice('left')).toBeNull()
  })

  it('falls back to defaults and warns when settings read throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(sqlite as any).exec(`DROP TABLE device_settings`)
    invalidateGuardSettingsCache()

    // Default threshold is 500, dwell 2 — so two sub-500 frames still trip.
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)
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
})
