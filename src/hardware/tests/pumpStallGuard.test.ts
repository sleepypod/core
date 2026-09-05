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
  completeResolution,
  dismissIfActive,
  confirmCutoff,
  identifyResolution,
  invalidateGuardSettingsCache,
  isCutoffPendingIncident,
  onFrame as onFrameImpl,
  rearm,
  rehydrate,
  reset,
  restoreAcknowledgedSession,
  shouldBlock,
  standDown,
  supersedeAlerts,
} from '../pumpStallGuard'
import { getPumpStallNotice } from '../pumpStallNotification'
import { withSideLock } from '../sideLock'
import { _resetMutationStamps, markSideMutated } from '../sideMutations'

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

const FRAME_GAP_MS = __test__.DWELL_MIN_MS + 1_000
let frameClock = Date.now()

// Most tests exercise state transitions rather than the dwell clock. Advance
// their synthetic frames beyond the production floor; dwell-specific tests
// call onFrameImpl directly with exact timestamps.
function onFrame(input: Parameters<typeof onFrameImpl>[0]): Promise<void> {
  frameClock += FRAME_GAP_MS
  return onFrameImpl({ now: frameClock, ...input })
}

describe('pumpStallGuard', () => {
  beforeEach(() => {
    _resetMutationStamps()
    frameClock = Date.now()
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

  it('does not carry a prior session snapshot into a later no-countdown trip', async () => {
    await onFrame({
      side: 'left',
      rpm: 1900,
      expectedActive: true,
      preStallTarget: 72,
      preStallDurationSeconds: 5400,
    })
    await onFrame({
      side: 'left',
      rpm: 0,
      expectedActive: false,
      preStallTarget: null,
      preStallDurationSeconds: null,
    })

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 79, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 79, preStallDurationSeconds: null })

    expect(__test__.getState().left.preStall).toBeNull()
    expect((biometricsSqlite as any).prepare(
      'SELECT restore_target_temperature, restore_duration_seconds FROM pump_alerts',
    ).get()).toEqual({ restore_target_temperature: null, restore_duration_seconds: null })
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

  describe('bilateral dwell and frame-arrival continuity', () => {
    // These drive onFrameImpl with explicit arrival stamps so the dwell clock
    // is exact — the shared onFrame wrapper's auto-advance would blur it.
    const low = (side: 'left' | 'right', now: number): Promise<void> =>
      onFrameImpl({ side, rpm: 0, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800, now })

    it('a single-sided low run still trips at the short dwell', async () => {
      const t0 = 1_000_000
      await low('left', t0)
      await low('left', t0 + __test__.DWELL_MIN_MS)
      expect(shouldBlock('left')).toBe(true)
    })

    it('holds a simultaneous both-side zero-RPM run to the bilateral dwell before dual-tripping', async () => {
      const t0 = 1_000_000
      // Feed both sides low together, a frame every 10s to keep run continuity.
      // A single-sided run would trip at DWELL_MIN_MS; the shared-onset run must
      // hold all the way to BILATERAL_DWELL_MIN_MS (the trinity 22:00 window is
      // longer than this, which is why the targetLevel reorder — not this dwell
      // — is what actually suppresses a real session-end stop).
      let t = t0
      for (; t < t0 + __test__.BILATERAL_DWELL_MIN_MS; t += 10_000) {
        await low('left', t)
        await low('right', t)
        expect(shouldBlock('left')).toBe(false)
        expect(shouldBlock('right')).toBe(false)
      }
      // A genuine shared supply fault still fails safe once the dwell elapses.
      await low('left', t0 + __test__.BILATERAL_DWELL_MIN_MS)
      expect(shouldBlock('left')).toBe(true)
    })

    it('does not extend the dwell when the two low runs began outside the onset window', async () => {
      const t0 = 1_000_000
      await low('right', t0)
      const late = t0 + __test__.BILATERAL_ONSET_WINDOW_MS + 5_000
      await low('left', late)
      await low('left', late + __test__.DWELL_MIN_MS)
      // Onsets > BILATERAL_ONSET_WINDOW_MS apart read as two independent events,
      // not a shared glitch, so the short single-side floor applies.
      expect(shouldBlock('left')).toBe(true)
    })

    it('restarts the low run after a frame-stream gap beyond FRAME_GAP_RESET_MS', async () => {
      const t0 = 1_000_000
      await low('left', t0)
      // This frame would be the second consecutive low frame and trip — but the
      // gap since the last frame exceeds the reset window, so the run restarts.
      await low('left', t0 + __test__.FRAME_GAP_RESET_MS + 1_000)
      expect(shouldBlock('left')).toBe(false)
      // Proof the run truly restarted: one more contiguous low frame past the
      // dwell now trips.
      await low('left', t0 + __test__.FRAME_GAP_RESET_MS + 1_000 + __test__.DWELL_MIN_MS)
      expect(shouldBlock('left')).toBe(true)
    })
  })

  describe('time-based dwell floor', () => {
    const low = (now: number) => ({
      side: 'left' as const,
      rpm: 100,
      expectedActive: true,
      preStallTarget: 78,
      preStallDurationSeconds: 28_800,
      now,
    })
    const base = 5_000_000

    it('does not trip when the frame count is met before ten seconds', async () => {
      await onFrameImpl(low(base))
      await onFrameImpl(low(base + 1_000))

      expect(shouldBlock('left')).toBe(false)
      expect(setPower).not.toHaveBeenCalled()
    })

    it('trips once one continuous low-RPM run crosses ten seconds', async () => {
      await onFrameImpl(low(base))
      await onFrameImpl(low(base + 1_000))
      await onFrameImpl(low(base + __test__.DWELL_MIN_MS))

      expect(shouldBlock('left')).toBe(true)
      expect(setPower).toHaveBeenCalledWith('left', false)
    })

    it('restarts the clock after a healthy frame', async () => {
      await onFrameImpl(low(base))
      await onFrameImpl({ ...low(base + 2_000), rpm: 1_900 })
      await onFrameImpl(low(base + 20_000))
      await onFrameImpl(low(base + 21_000))

      expect(shouldBlock('left')).toBe(false)
    })
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

  it('shares settings-cache invalidation across duplicated module instances', async () => {
    expect(__test__.readSettings().threshold).toBe(500)
    setSettings({ pump_stall_rpm_threshold: 777 })

    vi.resetModules()
    const duplicate = await import('../pumpStallGuard')

    expect(duplicate.__test__.getSettingsState()).toBe(__test__.getSettingsState())
    duplicate.invalidateGuardSettingsCache()
    expect(__test__.readSettings().threshold).toBe(777)
  })

  it('uses the complete fail-safe defaults after a degraded settings read', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ;(sqlite as any).exec('DELETE FROM device_settings')
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

  it('preserves an armed block and retries its cutoff when settings become unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setPower.mockRejectedValueOnce(new Error('DAC offline'))
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 3600 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 3600 })
    expect(__test__.getState().left.cutoffPending).toBe(true)

    ;(sqlite as any).exec('DELETE FROM device_settings')
    invalidateGuardSettingsCache()
    await onFrame({ side: 'left', rpm: 0, expectedActive: false, preStallTarget: null, preStallDurationSeconds: null })

    expect(shouldBlock('left')).toBe(true)
    expect(__test__.getState().left.cutoffPending).toBe(false)
    expect(setPower).toHaveBeenCalledTimes(2)
    expect(setPower).toHaveBeenLastCalledWith('left', false)
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
    expect(setPower.mock.calls).toEqual([['left', false]])
    expect(setTemperature).toHaveBeenCalledOnce()
    expect(setTemperature).toHaveBeenCalledWith('left', 78, 28_800 - 2 * FRAME_GAP_MS / 1000)
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
    expect(setPower.mock.calls).toEqual([['left', false]])
    expect(setTemperature).toHaveBeenCalledOnce()
  })

  it('a recovery probe restores only the un-elapsed remainder of the captured session', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 7200 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 7200 })
    expect(shouldBlock('left')).toBe(true)

    // The side sits parked for an hour before the pump proves healthy again;
    // replaying the full captured 7200s here would overshoot the session.
    const trippedAt = __test__.getState().left.trippedAt as number
    const healthy = { side: 'left' as const, rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 7200 }
    // The first frame after the 5-minute backoff starts the bounded probe and
    // resets the proof counter; two subsequent healthy frames confirm it.
    await onFrameImpl({ ...healthy, now: trippedAt + 3_600_000 })
    await onFrameImpl({ ...healthy, now: trippedAt + 3_600_000 })
    await onFrameImpl({ ...healthy, now: trippedAt + 3_600_000 })

    expect(shouldBlock('left')).toBe(false)
    expect(setPower.mock.calls).toEqual([['left', false]])
    expect(setTemperature.mock.calls).toEqual([
      ['left', 78, 60],
      ['left', 78, 3600],
    ])
  })

  it('auto-recover leaves the side off and stamps the alert once the captured session has expired', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 600 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 600 })
    setPower.mockClear()
    setTemperature.mockClear()

    // Exactly the captured window elapses — leftover 0 must not re-energize.
    const trippedAt = __test__.getState().left.trippedAt as number
    const healthy = { side: 'left' as const, rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 600 }
    await onFrameImpl({ ...healthy, now: trippedAt + 600_000 })
    await onFrameImpl({ ...healthy, now: trippedAt + 600_000 })

    expect(shouldBlock('left')).toBe(false)
    expect(setPower).not.toHaveBeenCalled()
    expect(setTemperature).not.toHaveBeenCalled()
    const alert = (biometricsSqlite as any).prepare('SELECT action, acknowledged_at FROM pump_alerts').get()
    expect(alert.action).toBe('auto_recovered')
    expect(alert.acknowledged_at).toBeTypeOf('number')
    expect(log).toHaveBeenCalledWith('[pumpStallGuard] auto-recovered left — original session expired, leaving off')
    log.mockRestore()
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

  it('acknowledge reserves the incident until its owner completes resolution', async () => {
    await onFrame({ side: 'right', rpm: 100, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'right', rpm: 100, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 28800 })
    expect(shouldBlock('right')).toBe(true)

    const { restore, alertId, conflict, rearmToken } = acknowledge('right')
    expect(restore).toEqual({ targetTemperature: 80, durationSeconds: 28800 })
    expect(alertId).toBeGreaterThan(0)
    expect(conflict).toBeNull()
    expect(rearmToken).not.toBeNull()
    expect(shouldBlock('right')).toBe(true)
    expect(getPumpStallNotice('right')).not.toBeNull()
    expect(acknowledge('right')).toMatchObject({ conflict: 'hardware_pending', rearmToken: null })

    expect(completeResolution('right', rearmToken as object)).toBe(true)
    expect(shouldBlock('right')).toBe(false)
    expect(getPumpStallNotice('right')).toBeNull()
  })

  it('allows exactly one reservation-owned restore while ordinary writes stay blocked', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 77, preStallDurationSeconds: 3600 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 77, preStallDurationSeconds: 3600 })
    const released = acknowledge('left')
    setTemperature.mockClear()

    await restoreAcknowledgedSession(
      'left',
      released.restore as { targetTemperature: number, durationSeconds: number },
      released.rearmToken as object,
    )

    expect(setTemperature).toHaveBeenCalledOnce()
    expect(setTemperature).toHaveBeenCalledWith('left', 77, 3600)
    expect(shouldBlock('left')).toBe(true)
    expect(isCutoffPendingIncident('left', released.alertId as number)).toBe(true)
    await expect(restoreAcknowledgedSession(
      'left',
      released.restore as { targetTemperature: number, durationSeconds: number },
      {},
    )).rejects.toThrow('superseded')
    expect(setTemperature).toHaveBeenCalledOnce()

    expect(completeResolution('left', released.rearmToken as object)).toBe(true)
    expect(shouldBlock('left')).toBe(false)
  })

  it('atomically attaches a restart-orphan id to its resolution reservation', () => {
    const released = acknowledge('left')

    expect(released.alertId).toBeNull()
    expect(identifyResolution('left', released.rearmToken as object, 81)).toBe(true)
    expect(isCutoffPendingIncident('left', 81)).toBe(true)
    expect(dismissIfActive('left', 81)).toBe(false)
    expect(completeResolution('left', released.rearmToken as object)).toBe(true)
  })

  it('refuses a stale alert id without clearing the current incident', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 3600 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 3600 })
    const activeAlertId = __test__.getState().left.activeAlertId as number

    const result = acknowledge('left', activeAlertId + 1)

    expect(result).toMatchObject({
      alertId: activeAlertId,
      conflict: 'alert_mismatch',
      rearmToken: null,
    })
    expect(shouldBlock('left')).toBe(true)
    expect(getPumpStallNotice('left')?.alertId).toBe(activeAlertId)
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

  it('keeps a failed restore gated until its compensating cutoff is confirmed', () => {
    const released = acknowledge('left')
    expect(rearm('left', {
      alertId: 9,
      restore: { targetTemperature: 77, durationSeconds: 3600 },
      cutoffPending: true,
    }, released.rearmToken as object)).toBe(true)

    expect(__test__.getState().left.cutoffPending).toBe(true)
    expect(acknowledge('left').conflict).toBe('hardware_pending')
    expect(confirmCutoff('left', released.rearmToken as object)).toBe(true)
    expect(__test__.getState().left.cutoffPending).toBe(false)
  })

  it('does not rearm an old acknowledgement over a newer incident', async () => {
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 76, preStallDurationSeconds: 3600 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 76, preStallDurationSeconds: 3600 })
    const oldAlertId = __test__.getState().left.activeAlertId as number
    const released = acknowledge('left', oldAlertId)

    // Simulate another owner replacing the reservation. Telemetry itself
    // cannot trip through resolutionPending, which is the race this token
    // is intended to close.
    reset('left')
    const newAlertId = oldAlertId + 1
    rearm('left', {
      alertId: newAlertId,
      restore: { targetTemperature: 79, durationSeconds: 1800 },
    })

    expect(rearm('left', {
      alertId: oldAlertId,
      restore: released.restore,
      trippedAt: released.trippedAt ?? undefined,
    }, released.rearmToken as object)).toBe(false)
    expect(__test__.getState().left.activeAlertId).toBe(newAlertId)
    expect(__test__.getState().left.preStall).toEqual({ targetTemperature: 79, durationSeconds: 1800 })
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

  it('does not fabricate an eight-hour snapshot when the frame has no live countdown', async () => {
    const now = 1_753_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    ;(sqlite as any).exec(`UPDATE device_state SET target_temperature = 82, powered_on_at = ${Math.floor(now / 1000) - 3600} WHERE side = 'left'`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(getPumpStallNotice('left')?.restore).toBeNull()
    expect((biometricsSqlite as any).prepare('SELECT restore_target_temperature, restore_duration_seconds FROM pump_alerts').get()).toEqual({
      restore_target_temperature: null,
      restore_duration_seconds: null,
    })
  })

  it('captures no fallback snapshot when device_state has no power-on timestamp', async () => {
    ;(sqlite as any).exec(`UPDATE device_state SET target_temperature = 82, powered_on_at = NULL WHERE side = 'left'`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(shouldBlock('left')).toBe(true)
    expect(getPumpStallNotice('left')?.restore).toBeNull()
    expect((biometricsSqlite as any).prepare('SELECT restore_target_temperature, restore_duration_seconds FROM pump_alerts').get()).toEqual({
      restore_target_temperature: null,
      restore_duration_seconds: null,
    })
  })

  it('captures no fallback snapshot when the default session window has already elapsed', async () => {
    const now = 1_753_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    ;(sqlite as any).exec(`UPDATE device_state SET target_temperature = 82, powered_on_at = ${Math.floor(now / 1000) - 28800} WHERE side = 'left'`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(shouldBlock('left')).toBe(true)
    expect(getPumpStallNotice('left')?.restore).toBeNull()
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

    const low = { side: 'right' as const, rpm: 499, expectedActive: true, preStallTarget: 80, preStallDurationSeconds: 1234 }
    await onFrameImpl({ ...low, now: now - __test__.DWELL_MIN_MS })
    await onFrameImpl({ ...low, now })

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

  it('retries the cutoff on post-trip frames where the DB mirror makes expectedActive false', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    setPower.mockRejectedValueOnce(new Error('hw down'))

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(__test__.getState().left.cutoffPending).toBe(true)

    // trip() mirrors isPowered=false, so every real post-trip frame arrives
    // with expectedActive=false — the pending cutoff must still be retried.
    await onFrame({ side: 'left', rpm: 100, expectedActive: false, preStallTarget: null, preStallDurationSeconds: null })
    expect(setPower).toHaveBeenLastCalledWith('left', false)
    expect(__test__.getState().left.cutoffPending).toBe(false)
    err.mockRestore()
  })

  it('auto-recovers from post-trip frames where expectedActive is false', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    expect(shouldBlock('left')).toBe(true)

    // Same DB-mirror reality as above: recovery tracking must keep running
    // on expectedActive=false frames or auto-recovery is unreachable.
    await onFrame({ side: 'left', rpm: 1900, expectedActive: false, preStallTarget: null, preStallDurationSeconds: null })
    expect(shouldBlock('left')).toBe(true)
    await onFrame({ side: 'left', rpm: 1900, expectedActive: false, preStallTarget: null, preStallDurationSeconds: null })
    expect(shouldBlock('left')).toBe(false)
    expect(setPower.mock.calls).toEqual([['left', false]])
    expect(setTemperature).toHaveBeenCalledOnce()
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

  it('does not acknowledge an id-less incident while its cutoff is unconfirmed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    let resolveCutoff!: () => void
    setPower.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveCutoff = resolve
    }))
    ;(biometricsSqlite as any).exec('DROP TABLE pump_alerts')

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 3600 })
    const tripping = onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 3600 })
    for (let i = 0; i < 5; i += 1) await Promise.resolve()

    expect(__test__.getState().left.activeAlertId).toBeNull()
    expect(acknowledge('left')).toMatchObject({
      alertId: null,
      conflict: 'hardware_pending',
      rearmToken: null,
    })
    expect(shouldBlock('left')).toBe(true)

    resolveCutoff()
    await tripping
    expect(acknowledge('left').conflict).toBeNull()
    err.mockRestore()
  })

  it('auto-recover with no snapshot resets the guard without re-energizing', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
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
    // The pump proved itself healthy — the alert must be stamped so a
    // restart doesn't rehydrate the block from the still-active row.
    const alert = (biometricsSqlite as any).prepare('SELECT action, acknowledged_at FROM pump_alerts').get()
    expect(alert.action).toBe('auto_recovered')
    expect(alert.acknowledged_at).toBeTypeOf('number')
    expect(log).toHaveBeenCalledWith('[pumpStallGuard] auto-recovered left — original session expired, leaving off')
    log.mockRestore()
  })

  it('does not clear the guard on recovery while the trip cutoff is still unsent', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // Trip-time cutoff and every per-frame retry fail — cutoffPending stays
    // set while the side may still be energized against the pump.
    setPower.mockRejectedValue(new Error('dac down'))
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    expect(shouldBlock('left')).toBe(true)
    expect(__test__.getState().left.cutoffPending).toBe(true)

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    // Recovery threshold reached, but the guard must stay armed until the
    // cutoff actually lands.
    expect(shouldBlock('left')).toBe(true)

    // Hardware comes back: the retry lands the cutoff, then the next healthy
    // frame's recovery pass clears the guard.
    setPower.mockResolvedValue(undefined)
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    expect(shouldBlock('left')).toBe(false)
    err.mockRestore()
    warn.mockRestore()
  })

  it('does not restamp an alert the user already acknowledged', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    // No snapshot: the recovery takes the leave-off path whose only DB write
    // is the alert stamp.
    ;(sqlite as any).exec(`UPDATE device_state SET target_temperature = NULL WHERE side = 'left'`)

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    expect(shouldBlock('left')).toBe(true)
    // User acknowledges through the router while the guard is still armed.
    ;(biometricsSqlite as any).exec('UPDATE pump_alerts SET acknowledged_at = 1234')

    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
    await onFrame({ side: 'left', rpm: 1900, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

    expect(shouldBlock('left')).toBe(false)
    const alert = (biometricsSqlite as any).prepare('SELECT action, acknowledged_at FROM pump_alerts').get()
    expect(alert.action).toBe('power_off')
    expect(alert.acknowledged_at).toBe(1234)
  })

  it('aborts auto-recover and logs when hardware call throws', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 2 })
    invalidateGuardSettingsCache()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
    setTemperature.mockRejectedValueOnce(new Error('hw down'))

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
    // Covers representative `err instanceof Error ? err.message : err`
    // branches in settings, trip hardware, and persistence paths.
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

    // The duration-bearing restore throws a non-Error during auto-recover.
    setTemperature.mockImplementationOnce(() => {
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
    // Rows must sit inside the seven-day rehydration window by default —
    // the age gate treats anything older as stale and dismisses it.
    const nowSec = Math.floor(Date.now() / 1000)

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
        row.timestamp ?? nowSec - 3600,
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
      const ts = nowSec - 600
      const id = insertAlert({ side: 'left', timestamp: ts, rpm: 90, restoreTarget: 81, restoreDuration: 5400 })

      rehydrate()

      expect(shouldBlock('left')).toBe(true)
      expect(shouldBlock('right')).toBe(false)
      const state = __test__.getState().left
      expect(state.activeAlertId).toBe(id)
      expect(state.trippedAt).toBe(ts * 1000)
      expect(state.preStall).toEqual({ targetTemperature: 81, durationSeconds: 5400 })
      expect(state.rehydrated).toBe(true)
      expect(getPumpStallNotice('left')).toEqual({
        alertId: id,
        trippedAt: ts,
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

    it('picks the newest row by id even when timestamps invert under clock skew', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // The older incident carries the NEWER wall timestamp — recorded
      // under a forward-skewed pre-NTP boot clock. id order is incident
      // order; timestamp order is not.
      const skewedOlder = insertAlert({ side: 'left', timestamp: nowSec - 300 })
      const genuineNewest = insertAlert({ side: 'left', timestamp: nowSec - 900 })
      expect(genuineNewest).toBeGreaterThan(skewedOlder)

      rehydrate()

      expect(__test__.getState().left.activeAlertId).toBe(genuineNewest)
      // ...and the supersede reaches the skewed row because both key on id.
      const skewedRow = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(skewedOlder)
      expect(skewedRow.dismissed_at).not.toBeNull()
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

    it('skips and dismisses rows older than the seven-day window', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const eightDaysSec = 8 * 24 * 60 * 60
      insertAlert({ side: 'left', timestamp: nowSec - eightDaysSec - 3600 })
      const newest = insertAlert({ side: 'left', timestamp: nowSec - eightDaysSec })

      rehydrate()

      expect(shouldBlock('left')).toBe(false)
      expect(getPumpStallNotice('left')).toBeNull()
      const rows = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts ORDER BY id').all()
      expect(rows).toHaveLength(2)
      for (const row of rows) expect(row.dismissed_at).not.toBeNull()
      expect(warn).toHaveBeenCalledWith(
        `[pumpStallGuard] skipped rehydration for left: alert ${newest} is 8d old — dismissed 2 stale row(s)`,
      )
      warn.mockRestore()
    })

    it('treats a future-timestamped row as fresh and re-blocks (clock-skew fail-safe)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const id = insertAlert({ side: 'left', timestamp: nowSec + 3600 })

      rehydrate()

      expect(shouldBlock('left')).toBe(true)
      expect(__test__.getState().left.activeAlertId).toBe(id)
      warn.mockRestore()
    })

    it('treats a row more than seven days in the future as fresh (signed age, not absolute)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const id = insertAlert({ side: 'left', timestamp: nowSec + 8 * 24 * 60 * 60 })

      rehydrate()

      expect(shouldBlock('left')).toBe(true)
      expect(__test__.getState().left.activeAlertId).toBe(id)
      const row = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(id)
      expect(row.dismissed_at).toBeNull()
      warn.mockRestore()
    })

    it('treats a near-epoch timestamp as write-time clock skew, not staleness', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // A pod that tripped before its clock ever synced writes ~1970. The
      // true age is unknowable — the row must re-block, not be dismissed.
      const id = insertAlert({ side: 'left', timestamp: 100_000 })

      rehydrate()

      expect(shouldBlock('left')).toBe(true)
      expect(__test__.getState().left.activeAlertId).toBe(id)
      const row = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(id)
      expect(row.dismissed_at).toBeNull()
      warn.mockRestore()
    })

    it('supersedes older active rows for the side when re-blocking from the newest', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const older = insertAlert({ side: 'left', timestamp: nowSec - 3200 })
      const evenNewer = insertAlert({ side: 'left', timestamp: nowSec - 3000 })
      const otherSide = insertAlert({ side: 'right', timestamp: nowSec - 3000 })
      // Rows a supersede must never touch, even inside the id range:
      const acked = insertAlert({ side: 'left', timestamp: nowSec - 2900, acknowledgedAt: nowSec - 2800 })
      const preDismissed = insertAlert({ side: 'left', timestamp: nowSec - 2900, dismissedAt: 1_720_000_100 })
      const warned = insertAlert({ side: 'left', timestamp: nowSec - 2900, action: 'warned' })
      const newest = insertAlert({ side: 'left', timestamp: nowSec - 600 })

      rehydrate()

      expect(__test__.getState().left.activeAlertId).toBe(newest)
      const rowById = (id: number) => (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(id)
      expect(rowById(older).dismissed_at).not.toBeNull()
      expect(rowById(evenNewer).dismissed_at).not.toBeNull()
      // Acknowledged history keeps its record, an existing dismissal keeps
      // its original stamp, and non-power_off rows are untouched.
      expect(rowById(acked).dismissed_at).toBeNull()
      expect(rowById(preDismissed).dismissed_at).toBe(1_720_000_100)
      expect(rowById(warned).dismissed_at).toBeNull()
      // The other side's incident is its own lineage — rehydrated, not stamped.
      expect(__test__.getState().right.activeAlertId).toBe(otherSide)
      warn.mockRestore()
    })

    it('supersedeAlerts without a bound dismisses every active power_off row for the side only', () => {
      const a = insertAlert({ side: 'left', timestamp: nowSec - 3000 })
      const b = insertAlert({ side: 'left', timestamp: nowSec - 600 })
      const acked = insertAlert({ side: 'left', timestamp: nowSec - 600, acknowledgedAt: nowSec - 500 })
      const other = insertAlert({ side: 'right', timestamp: nowSec - 600 })

      expect(supersedeAlerts('left')).toBe(2)

      const rowById = (id: number) => (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(id)
      expect(rowById(a).dismissed_at).not.toBeNull()
      expect(rowById(b).dismissed_at).not.toBeNull()
      expect(rowById(acked).dismissed_at).toBeNull()
      expect(rowById(other).dismissed_at).toBeNull()
    })

    it('a fresh trip supersedes older active rows for the side', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const stale = insertAlert({ side: 'left', timestamp: nowSec - 3000 })
      const otherSide = insertAlert({ side: 'right', timestamp: nowSec - 3000 })

      await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
      await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })

      expect(shouldBlock('left')).toBe(true)
      const staleRow = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(stale)
      expect(staleRow.dismissed_at).not.toBeNull()
      const otherRow = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(otherSide)
      expect(otherRow.dismissed_at).toBeNull()
      const tripRow = (biometricsSqlite as any)
        .prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?')
        .get(__test__.getState().left.activeAlertId)
      expect(tripRow.dismissed_at).toBeNull()
      warn.mockRestore()
    })

    describe('rehydrated block lifecycle', () => {
      const healthyFrame = (side: 'left' | 'right') =>
        onFrame({ side, rpm: 1950, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
      const stalledFrame = (side: 'left' | 'right') =>
        onFrame({ side, rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })

      it('releases after recoverySamples healthy frames without touching hardware', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const id = insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()
        expect(shouldBlock('left')).toBe(true)

        await healthyFrame('left')
        await healthyFrame('left')
        // Below recoverySamples (3) the block must hold.
        expect(shouldBlock('left')).toBe(true)
        await healthyFrame('left')

        expect(shouldBlock('left')).toBe(false)
        expect(getPumpStallNotice('left')).toBeNull()
        expect(setPower).not.toHaveBeenCalled()
        expect(setTemperature).not.toHaveBeenCalled()
        const row = (biometricsSqlite as any).prepare('SELECT action, acknowledged_at FROM pump_alerts WHERE id = ?').get(id)
        expect(row.action).toBe('auto_recovered')
        expect(row.acknowledged_at).not.toBeNull()
        expect(log).toHaveBeenCalledWith('[pumpStallGuard] released rehydrated block for left — pump verified healthy')
        warn.mockRestore()
        log.mockRestore()
      })

      it('lets opt-in auto-recovery keep precedence over the rehydrated release', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        setSettings({ pump_stall_auto_recovery_enabled: 1 })
        invalidateGuardSettingsCache()
        insertAlert({ side: 'left', timestamp: nowSec - 600, restoreTarget: 78, restoreDuration: 28800 })
        rehydrate()

        await healthyFrame('left')
        await healthyFrame('left')
        await healthyFrame('left')
        await healthyFrame('left')

        // The old incident immediately qualifies for a probe: one short
        // duration-bearing lease, then one final aged restore.
        expect(setPower).not.toHaveBeenCalled()
        expect(setTemperature).toHaveBeenCalledTimes(2)
        expect(setTemperature).toHaveBeenNthCalledWith(1, 'left', 78, 60)
        expect(shouldBlock('left')).toBe(false)
        warn.mockRestore()
        log.mockRestore()
      })

      it('powers off a rehydrated side observed energized below the stall threshold', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        await stalledFrame('left')
        // One frame below the dwell window (2) must not cut power.
        expect(setPower).not.toHaveBeenCalled()
        await stalledFrame('left')

        expect(setPower).toHaveBeenCalledWith('left', false)
        expect(shouldBlock('left')).toBe(true)
        expect(__test__.getState().left.cutoffPending).toBe(false)
        // The stall was re-confirmed this boot — the block is fresh now.
        expect(__test__.getState().left.rehydrated).toBe(false)
        expect(warn).toHaveBeenCalledWith('[pumpStallGuard] rehydrated block for left sees an energized stalled pump — powering off')

        // A further stalled frame must not issue a second cutoff.
        await stalledFrame('left')
        expect(setPower).toHaveBeenCalledTimes(1)
        warn.mockRestore()
      })

      it('never arms the cutoff from non-consecutive low frames', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        await stalledFrame('left')
        await healthyFrame('left')
        await stalledFrame('left')

        // The intervening healthy frame proved circulation — the dwell
        // requires consecutive sub-threshold frames.
        expect(setPower).not.toHaveBeenCalled()
        expect(__test__.getState().left.cutoffPending).toBe(false)
        expect(shouldBlock('left')).toBe(true)
        warn.mockRestore()
      })

      it('never arms the cutoff from frames on a side commanded off', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        for (let i = 0; i < 5; i += 1) {
          await onFrame({ side: 'left', rpm: 0, expectedActive: false, preStallTarget: null, preStallDurationSeconds: null })
        }

        expect(setPower).not.toHaveBeenCalled()
        expect(shouldBlock('left')).toBe(true)
        warn.mockRestore()
      })

      it('requires explicit acknowledgement once this boot observed an energized stall', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        setPower.mockImplementation(async () => {
          throw new Error('hardware offline')
        })
        await stalledFrame('left')
        await stalledFrame('left')
        expect(__test__.getState().left.cutoffPending).toBe(true)

        await healthyFrame('left')
        await healthyFrame('left')
        await healthyFrame('left')
        // The pump looks healthy, but the unconfirmed cutoff pins the block.
        expect(shouldBlock('left')).toBe(true)

        setPower.mockImplementation(async () => {})
        await healthyFrame('left')
        // The retry landed, but the stall was re-confirmed live this boot —
        // the block was promoted to fresh at cutoff-arm time and only an
        // explicit acknowledgement may release it now.
        expect(__test__.getState().left.cutoffPending).toBe(false)
        expect(shouldBlock('left')).toBe(true)
        warn.mockRestore()
      })

      it('requires explicit acknowledgement again after a failed restore re-arms', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()
        const { restore, alertId } = acknowledge('left')
        rearm('left', { alertId, restore })

        for (let i = 0; i < 5; i += 1) await healthyFrame('left')

        expect(shouldBlock('left')).toBe(true)
        warn.mockRestore()
      })

      it('keeps the energized-stall watch scoped to rehydrated blocks — a fresh trip never re-arms', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        await stalledFrame('left')
        await stalledFrame('left')
        expect(shouldBlock('left')).toBe(true)
        expect(__test__.getState().left.rehydrated).toBe(false)
        expect(__test__.getState().left.cutoffPending).toBe(false)
        expect(setPower).toHaveBeenCalledTimes(1)

        // >= dwellSamples further energized-stalled frames on the fresh
        // block must not arm the watch (it belongs to rehydrated blocks).
        await stalledFrame('left')
        await stalledFrame('left')
        await stalledFrame('left')
        expect(__test__.getState().left.cutoffPending).toBe(false)
        expect(setPower).toHaveBeenCalledTimes(1)

        // Nor may the fresh block self-release on healthy frames.
        for (let i = 0; i < 5; i += 1) await healthyFrame('left')
        expect(shouldBlock('left')).toBe(true)
        warn.mockRestore()
      })

      it('the disabled branch drops the rehydrated flag with the block', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()
        expect(__test__.getState().left.rehydrated).toBe(true)

        setSettings({ pump_stall_protection_enabled: 0 })
        invalidateGuardSettingsCache()
        await healthyFrame('left')

        expect(shouldBlock('left')).toBe(false)
        expect(__test__.getState().left.rehydrated).toBe(false)
        warn.mockRestore()
      })

      it('release-time supersede also drains rows that became active after rehydration', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const older = insertAlert({ side: 'left', timestamp: nowSec - 3000 })
        const id = insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()
        // Simulate a row rehydrate never saw (e.g. a silent stamp failure
        // healed elsewhere): re-activate the superseded older row.
        ;(biometricsSqlite as any).exec(`UPDATE pump_alerts SET dismissed_at = NULL WHERE id = ${older}`)

        await healthyFrame('left')
        await healthyFrame('left')
        await healthyFrame('left')

        expect(shouldBlock('left')).toBe(false)
        const releasedRow = (biometricsSqlite as any).prepare('SELECT action FROM pump_alerts WHERE id = ?').get(id)
        expect(releasedRow.action).toBe('auto_recovered')
        const olderRow = (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(older)
        expect(olderRow.dismissed_at).not.toBeNull()
        warn.mockRestore()
        log.mockRestore()
      })
    })

    describe('dismissIfActive', () => {
      it('releases the matching live incident', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const id = insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        expect(dismissIfActive('left', id)).toBe(true)
        expect(shouldBlock('left')).toBe(false)
        expect(getPumpStallNotice('left')).toBeNull()
        warn.mockRestore()
      })

      it('refuses a non-matching id and an unblocked side', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const id = insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        expect(dismissIfActive('left', id + 1)).toBe(false)
        expect(shouldBlock('left')).toBe(true)
        expect(dismissIfActive('right', id)).toBe(false)
        warn.mockRestore()
      })

      it('refuses while the cutoff retry is still pending', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const id = insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()
        setPower.mockImplementation(async () => {
          throw new Error('hardware offline')
        })
        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
        expect(__test__.getState().left.cutoffPending).toBe(true)
        expect(isCutoffPendingIncident('left', id)).toBe(true)

        expect(dismissIfActive('left', id)).toBe(false)
        expect(shouldBlock('left')).toBe(true)
        setPower.mockImplementation(async () => {})
        warn.mockRestore()
      })

      it('refuses while the trip-time cutoff is still in flight', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        let resolveCutoff!: () => void
        setPower.mockImplementationOnce(
          () => new Promise<void>((resolve) => {
            resolveCutoff = resolve
          }),
        )

        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
        const tripping = onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 })
        for (let i = 0; i < 5; i += 1) await Promise.resolve()

        // The row and banner are already visible, so a dismissal can land
        // in this window — it must see an unconfirmed cutoff and refuse,
        // or the awaited power-off would resolve against an orphaned state
        // and the retry machinery would be lost.
        const alertId = __test__.getState().left.activeAlertId
        expect(alertId).not.toBeNull()
        expect(__test__.getState().left.cutoffPending).toBe(true)
        expect(dismissIfActive('left', alertId as number)).toBe(false)
        expect(shouldBlock('left')).toBe(true)

        resolveCutoff()
        await tripping
        // Confirmed cutoff resolves the flag on the live state.
        expect(__test__.getState().left.cutoffPending).toBe(false)
        expect(dismissIfActive('left', alertId as number)).toBe(true)
        expect(shouldBlock('left')).toBe(false)
        warn.mockRestore()
      })
    })

    describe('standDown', () => {
      it('attempts one final cutoff for a side with an unconfirmed power-off, then clears everything', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const id = insertAlert({ side: 'left', timestamp: nowSec - 600 })
        const other = insertAlert({ side: 'right', timestamp: nowSec - 600 })
        rehydrate()
        // Arm an unconfirmed cutoff on left via the energized-stall watch.
        setPower.mockImplementation(async () => {
          throw new Error('hardware offline')
        })
        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
        expect(__test__.getState().left.cutoffPending).toBe(true)
        setPower.mockImplementation(async () => {})
        setPower.mockClear()

        await standDown()

        // One final best-effort cutoff for the pending side only.
        expect(setPower).toHaveBeenCalledTimes(1)
        expect(setPower).toHaveBeenCalledWith('left', false)
        expect(warn).toHaveBeenCalledWith('[pumpStallGuard] standing down left with hardware not confirmed off — attempting final power-off')
        expect(shouldBlock('left')).toBe(false)
        expect(shouldBlock('right')).toBe(false)
        expect(getPumpStallNotice('left')).toBeNull()
        expect(getPumpStallNotice('right')).toBeNull()
        const rowById = (rowId: number) => (biometricsSqlite as any).prepare('SELECT dismissed_at FROM pump_alerts WHERE id = ?').get(rowId)
        expect(rowById(id).dismissed_at).not.toBeNull()
        expect(rowById(other).dismissed_at).not.toBeNull()
        warn.mockRestore()
      })

      it('still resets when the final cutoff fails, and warns', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()
        setPower.mockImplementation(async () => {
          throw new Error('hardware offline')
        })
        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
        await onFrame({ side: 'left', rpm: 100, expectedActive: true, preStallTarget: null, preStallDurationSeconds: null })
        expect(__test__.getState().left.cutoffPending).toBe(true)

        await standDown()

        expect(warn).toHaveBeenCalledWith('[pumpStallGuard] final cutoff for left failed:', 'hardware offline')
        expect(shouldBlock('left')).toBe(false)
        setPower.mockImplementation(async () => {})
        warn.mockRestore()
      })

      it('issues no hardware writes when nothing is pending', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        insertAlert({ side: 'left', timestamp: nowSec - 600 })
        rehydrate()

        await standDown()

        expect(setPower).not.toHaveBeenCalled()
        expect(shouldBlock('left')).toBe(false)
        warn.mockRestore()
      })
    })
  })
})

describe('pumpStallGuard — side-lock serialization and notice timing', () => {
  const lowFrame = (side: 'left' | 'right') => ({
    side,
    rpm: 100,
    expectedActive: true,
    preStallTarget: 78,
    preStallDurationSeconds: 28800,
  })

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
  }

  beforeEach(() => {
    _resetMutationStamps()
    frameClock = Date.now()
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

  it('queues the trip cutoff behind a same-side writer already holding the lock', async () => {
    const order: string[] = []
    let releaseWriter!: () => void
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const writerDone = withSideLock('left', async () => {
      await writerGate
      order.push('writer:on')
    })

    await onFrame(lowFrame('left'))
    const tripping = onFrame(lowFrame('left'))
    await flush()

    // Trip already latched (block + banner) but the cutoff is still queued
    // behind the writer — nothing has reached the hardware client yet.
    expect(shouldBlock('left')).toBe(true)
    expect(getPumpStallNotice('left')).not.toBeNull()
    expect(setPower).not.toHaveBeenCalled()

    setPower.mockImplementation(async () => {
      order.push('guard:cutoff')
    })
    releaseWriter()
    await writerDone
    await tripping

    // The energizing write landed first, the cutoff after it — never the
    // reverse — so the side ends up OFF.
    expect(order).toEqual(['writer:on', 'guard:cutoff'])
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('serializes the cutoff retry through the side lock', async () => {
    setPower.mockRejectedValueOnce(new Error('socket gone'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await onFrame(lowFrame('left'))
    await onFrame(lowFrame('left'))
    expect(shouldBlock('left')).toBe(true)
    err.mockRestore()

    const order: string[] = []
    let releaseWriter!: () => void
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const writerDone = withSideLock('left', async () => {
      await writerGate
      order.push('writer:on')
    })

    setPower.mockImplementation(async () => {
      order.push('guard:retry')
    })
    const retrying = onFrame(lowFrame('left'))
    await flush()
    expect(order).toEqual([])

    releaseWriter()
    await writerDone
    await retrying
    expect(order).toEqual(['writer:on', 'guard:retry'])
  })

  it.each(['healthy recovery', 'recovery probe'] as const)('%s respects an OFF queued before recovery', async (kind) => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 1 })
    invalidateGuardSettingsCache()
    await onFrame(lowFrame('left'))
    await onFrame(lowFrame('left'))
    const state = __test__.getState().left
    const alertId = state.activeAlertId
    const tripAt = state.trippedAt ?? 0
    setPower.mockClear()
    setTemperature.mockClear()

    let releaseWriter!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const writer = withSideLock('left', async () => {
      await gate
      vi.spyOn(Date, 'now').mockReturnValue(tripAt + 1)
      markSideMutated('left')
    })
    const recovering = onFrameImpl({
      ...lowFrame('left'),
      rpm: kind === 'healthy recovery' ? 1900 : 0,
      now: tripAt + (kind === 'healthy recovery' ? 10_000 : __test__.PROBE_BACKOFFS_MS[0]),
    })
    await flush()
    expect(setTemperature).not.toHaveBeenCalled()
    releaseWriter()
    await writer
    await recovering

    expect(setPower).not.toHaveBeenCalled()
    expect(setTemperature).not.toHaveBeenCalled()
    expect(shouldBlock('left')).toBe(false)
    expect(getPumpStallNotice('left')).toBeNull()
    expect((sqlite as any).prepare('SELECT is_powered FROM device_state WHERE side = \'left\'').get().is_powered).toBe(0)
    const row = (biometricsSqlite as any).prepare('SELECT action, acknowledged_at FROM pump_alerts WHERE id = ?').get(alertId)
    expect(row.action).toBe('power_off')
    expect(row.acknowledged_at).not.toBeNull()
  })

  it.each(['older same-side', 'newer other-side'] as const)('allows recovery after an %s command', async (kind) => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 1 })
    invalidateGuardSettingsCache()
    await onFrame(lowFrame('left'))
    await onFrame(lowFrame('left'))
    const tripAt = __test__.getState().left.trippedAt ?? 0
    vi.spyOn(Date, 'now').mockReturnValue(tripAt + (kind === 'older same-side' ? -1 : 1))
    markSideMutated(kind === 'older same-side' ? 'left' : 'right')
    await onFrameImpl({ ...lowFrame('left'), rpm: 1900, now: tripAt + 10_000 })
    expect(setTemperature).toHaveBeenCalledWith('left', 78, 28_790)
    expect(shouldBlock('left')).toBe(false)
  })

  it('keeps a later OFF after the recovery hardware write and powered mirror', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 1 })
    invalidateGuardSettingsCache()
    await onFrame(lowFrame('left'))
    await onFrame(lowFrame('left'))
    let offWriter: Promise<void> | undefined
    setTemperature.mockImplementationOnce(async () => {
      offWriter = withSideLock('left', async () => {
        expect((sqlite as any).prepare('SELECT is_powered FROM device_state WHERE side = \'left\'').get().is_powered).toBe(1)
        ;(sqlite as any).exec('UPDATE device_state SET is_powered = 0 WHERE side = \'left\'')
      })
    })
    await onFrame({ ...lowFrame('left'), rpm: 1900 })
    await offWriter
    expect((sqlite as any).prepare('SELECT is_powered FROM device_state WHERE side = \'left\'').get().is_powered).toBe(0)
  })

  it('serializes the auto-recovery restore through the side lock', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 1 })
    invalidateGuardSettingsCache()
    await onFrame(lowFrame('left'))
    await onFrame(lowFrame('left'))
    expect(shouldBlock('left')).toBe(true)
    setPower.mockClear()

    const order: string[] = []
    let releaseWriter!: () => void
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve
    })
    const writerDone = withSideLock('left', async () => {
      await writerGate
      order.push('writer')
    })

    setTemperature.mockImplementation(async () => {
      order.push('guard:restore-duration')
    })
    const healthy = { side: 'left' as const, rpm: 1900, expectedActive: true, preStallTarget: 78, preStallDurationSeconds: 28800 }
    const recovering = onFrame(healthy)
    await flush()
    expect(order).toEqual([])

    releaseWriter()
    await writerDone
    await recovering
    expect(order).toEqual(['writer', 'guard:restore-duration'])
    expect(setTemperature).toHaveBeenCalledWith('left', 78, 28_800 - FRAME_GAP_MS / 1000)
    expect(shouldBlock('left')).toBe(false)
  })

  it('publishes the notice, alert row, and DB mirror before the cutoff resolves', async () => {
    let resolveCutoff!: () => void
    setPower.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveCutoff = resolve
      }),
    )

    await onFrame(lowFrame('left'))
    const tripping = onFrame(lowFrame('left'))
    await flush()

    // Cutoff still awaiting hardware — banner, alert row, and device_state
    // mirror must already be visible so the trip is explained during a slow
    // or unresponsive firmware window.
    const notice = getPumpStallNotice('left')
    expect(notice?.alertId).toBeGreaterThan(0)
    expect((biometricsSqlite as any).prepare('SELECT action FROM pump_alerts WHERE id = ?').get(notice?.alertId)).toEqual({ action: 'power_off' })
    expect((sqlite as any).prepare('SELECT is_powered FROM device_state WHERE side = \'left\'').get()).toEqual({ is_powered: 0 })

    resolveCutoff()
    await tripping
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('refuses acknowledgement until a pending cutoff is confirmed', async () => {
    let resolveCutoff!: () => void
    setPower.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveCutoff = resolve
      }),
    )

    await onFrame(lowFrame('left'))
    const tripping = onFrame(lowFrame('left'))
    await flush()
    expect(getPumpStallNotice('left')).not.toBeNull()

    expect(acknowledge('left')).toMatchObject({ conflict: 'hardware_pending', rearmToken: null })
    expect(getPumpStallNotice('left')).not.toBeNull()
    expect(shouldBlock('left')).toBe(true)

    resolveCutoff()
    await tripping
    const released = acknowledge('left')
    expect(released.conflict).toBeNull()
    expect(getPumpStallNotice('left')).not.toBeNull()
    expect(shouldBlock('left')).toBe(true)
    expect(completeResolution('left', released.rearmToken as object)).toBe(true)
    expect(getPumpStallNotice('left')).toBeNull()
    expect(shouldBlock('left')).toBe(false)
  })
})

describe('pumpStallGuard — active recovery probes', () => {
  let clock = 1_800_000_000_000

  const advance = (ms: number): void => {
    clock += ms
  }

  const frame = (rpm: number, options?: {
    side?: 'left' | 'right'
    target?: number | null
    duration?: number | null
  }): Promise<void> => onFrameImpl({
    side: options?.side ?? 'left',
    rpm,
    // The trip mirrors the side off immediately, so real post-trip frames are
    // inactive. A blocked side must still run the probe state machine.
    expectedActive: rpm === 100,
    preStallTarget: options?.target === undefined ? 78 : options.target,
    preStallDurationSeconds: options?.duration === undefined ? 28_800 : options.duration,
    now: clock,
  })

  async function trip(options?: { duration?: number | null, target?: number | null }): Promise<number> {
    await frame(100, options)
    advance(__test__.DWELL_MIN_MS)
    await frame(100, options)
    expect(shouldBlock('left')).toBe(true)
    const trippedAt = __test__.getState().left.trippedAt as number
    setPower.mockClear()
    setTemperature.mockClear()
    return trippedAt
  }

  beforeEach(() => {
    resetSchema()
    setSettings({ pump_stall_auto_recovery_enabled: 1, pump_stall_recovery_samples: 3 })
    invalidateGuardSettingsCache()
    reset()
    setPower.mockReset().mockResolvedValue(undefined)
    setTemperature.mockReset().mockResolvedValue(undefined)
    clock = 1_800_000_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
  })

  afterEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('starts only after the first backoff, uses a short lease, then restores the aged remainder', async () => {
    const trippedAt = await trip()

    advance(__test__.PROBE_BACKOFFS_MS[0] - 1)
    await frame(0)
    expect(setTemperature).not.toHaveBeenCalled()

    advance(1)
    await frame(0)
    expect(setTemperature).toHaveBeenCalledOnce()
    expect(setTemperature).toHaveBeenNthCalledWith(1, 'left', 78, 60)
    expect(setPower).not.toHaveBeenCalled()
    expect(__test__.getState().left.probeStartedAt).toBe(clock)

    await frame(1_900)
    await frame(1_900)
    await frame(1_900)

    const remaining = 28_800 - (clock - trippedAt) / 1000
    expect(setTemperature).toHaveBeenNthCalledWith(2, 'left', 78, remaining)
    expect(setPower).not.toHaveBeenCalled()
    expect(shouldBlock('left')).toBe(false)
    expect((biometricsSqlite as any).prepare('SELECT action FROM pump_alerts').get()).toEqual({ action: 'auto_recovered' })
  })

  it('powers off failed probes and applies the 5m, 15m, and 30m backoffs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trip()

    for (const backoff of __test__.PROBE_BACKOFFS_MS) {
      advance(backoff - 1)
      await frame(0)
      const attemptsBefore = __test__.getState().left.recoveryAttempts
      advance(1)
      await frame(0)
      expect(__test__.getState().left.recoveryAttempts).toBe(attemptsBefore + 1)

      advance(__test__.PROBE_WINDOW_MS)
      await frame(0)
      expect(__test__.getState().left.probeStartedAt).toBeNull()
      expect(shouldBlock('left')).toBe(true)
    }

    expect(setTemperature).toHaveBeenCalledTimes(3)
    expect(setPower.mock.calls).toEqual([
      ['left', false],
      ['left', false],
      ['left', false],
    ])
    expect(warn).toHaveBeenCalledWith('[pumpStallGuard] left pump still stalled after 3 recovery probes — staying off until acknowledged')

    advance(__test__.PROBE_BACKOFFS_MS[2] * 10)
    await frame(0)
    expect(setTemperature).toHaveBeenCalledTimes(3)
  })

  it('never probes without a truthful live-countdown snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trip({ target: null, duration: null })

    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0, { target: null, duration: null })

    expect(setTemperature).not.toHaveBeenCalled()
    expect(setPower).not.toHaveBeenCalled()
    expect(shouldBlock('left')).toBe(true)
    expect(__test__.getState().left.recoveryAttempts).toBe(__test__.PROBE_BACKOFFS_MS.length)
    expect(warn).toHaveBeenCalledWith('[pumpStallGuard] cannot probe left recovery without a session snapshot — staying off until acknowledged')
  })

  it('retires an already-expired short session without re-energizing it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await trip({ duration: 91 })

    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0, { duration: 91 })

    expect(setTemperature).not.toHaveBeenCalled()
    expect(setPower).not.toHaveBeenCalled()
    expect(shouldBlock('left')).toBe(false)
    expect(log).toHaveBeenCalledWith('[pumpStallGuard] auto-recovered left — original session expired, leaving off')
  })

  it('parks after a probe energize failure and waits for the next backoff', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trip()
    setTemperature.mockRejectedValueOnce(new Error('socket gone'))

    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0)

    expect(setPower).toHaveBeenCalledOnce()
    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(__test__.getState().left.probeStartedAt).toBeNull()
    expect(__test__.getState().left.recoveryAttempts).toBe(1)
    expect(shouldBlock('left')).toBe(true)
    expect(warn).toHaveBeenCalledWith('[pumpStallGuard] recovery probe energize for left failed:', 'socket gone')

    advance(__test__.PROBE_BACKOFFS_MS[1] - 1)
    await frame(0)
    expect(setTemperature).toHaveBeenCalledTimes(1)
  })

  it('keeps dismissal gated while parking after a partial probe energize failure', async () => {
    await trip()
    let resolvePark!: () => void
    setTemperature.mockRejectedValueOnce(new Error('partial write'))
    setPower.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePark = resolve
    }))

    advance(__test__.PROBE_BACKOFFS_MS[0])
    const probing = frame(0)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()

    expect(__test__.getState().left.probeStartedAt).toBeNull()
    expect(__test__.getState().left.cutoffPending).toBe(true)
    expect(acknowledge('left').conflict).toBe('hardware_pending')
    expect(shouldBlock('left')).toBe(true)

    resolvePark()
    await probing
    expect(__test__.getState().left.cutoffPending).toBe(false)
  })

  it('keeps the cutoff retry armed when a failed probe cannot be parked', async () => {
    await trip()
    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0)
    setPower.mockRejectedValueOnce(new Error('DAC offline'))

    advance(__test__.PROBE_WINDOW_MS)
    await frame(0)

    expect(shouldBlock('left')).toBe(true)
    expect(__test__.getState().left.cutoffPending).toBe(true)
    expect(__test__.getState().left.probeStartedAt).toBeNull()

    await frame(0)
    expect(setPower).toHaveBeenLastCalledWith('left', false)
    expect(__test__.getState().left.cutoffPending).toBe(false)
  })

  it('keeps dismissal gated for the whole failed-probe park', async () => {
    await trip()
    const alertId = __test__.getState().left.activeAlertId as number
    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0)

    let resolvePark!: () => void
    setPower.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolvePark = resolve
    }))
    advance(__test__.PROBE_WINDOW_MS)
    const ending = frame(0)
    for (let i = 0; i < 5; i += 1) await Promise.resolve()

    expect(__test__.getState().left.probeStartedAt).toBeNull()
    expect(__test__.getState().left.cutoffPending).toBe(true)
    expect(isCutoffPendingIncident('left', alertId)).toBe(true)
    expect(dismissIfActive('left', alertId)).toBe(false)

    resolvePark()
    await ending
    expect(__test__.getState().left.cutoffPending).toBe(false)
  })

  it('refuses dismissal while a probe has the side energized', async () => {
    await trip()
    const alertId = __test__.getState().left.activeAlertId as number
    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0)

    expect(isCutoffPendingIncident('left', alertId)).toBe(true)
    expect(dismissIfActive('left', alertId)).toBe(false)
    expect(shouldBlock('left')).toBe(true)
  })

  it('does not schedule probes when auto-recovery is disabled', async () => {
    setSettings({ pump_stall_auto_recovery_enabled: 0 })
    invalidateGuardSettingsCache()
    await trip()

    advance(__test__.PROBE_BACKOFFS_MS[0] * 2)
    await frame(0)

    expect(setTemperature).not.toHaveBeenCalled()
    expect(setPower).not.toHaveBeenCalled()
    expect(shouldBlock('left')).toBe(true)
  })

  it('parks an active probe before honoring an auto-recovery disable', async () => {
    setSettings({ pump_stall_recovery_samples: 1 })
    invalidateGuardSettingsCache()
    await trip()
    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0)
    __test__.getState().left.rehydrated = true

    setSettings({ pump_stall_auto_recovery_enabled: 0 })
    invalidateGuardSettingsCache()
    await frame(1900)

    expect(setPower).toHaveBeenCalledOnce()
    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(__test__.getState().left.probeStartedAt).toBeNull()
    expect(shouldBlock('left')).toBe(true)
    expect((biometricsSqlite as any).prepare('SELECT action FROM pump_alerts').get()).toEqual({ action: 'power_off' })
  })

  it('parks an active probe and preserves its block when settings cannot be read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await trip()
    advance(__test__.PROBE_BACKOFFS_MS[0])
    await frame(0)

    ;(sqlite as any).exec('DROP TABLE device_settings')
    invalidateGuardSettingsCache()
    await frame(0)

    expect(setPower).toHaveBeenCalledOnce()
    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(__test__.getState().left.probeStartedAt).toBeNull()
    expect(__test__.getState().left.cutoffPending).toBe(false)
    expect(shouldBlock('left')).toBe(true)
    warn.mockRestore()
  })
})
