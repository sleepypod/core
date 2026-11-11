import type Database from 'better-sqlite3'
import { arrangementDigest, readArrangementArchive } from './arrangementTransitionState'
import { rejectArrangementTransition } from './arrangementTransitionRecord'

/** Hash operating controls, excluding unpublished personal drafts, credentials and live telemetry. */
export function arrangementResumeDigest(database: Database.Database, householdId: string) {
  const tables = ['automations', 'tap_gestures', 'power_schedules', 'temperature_schedules', 'alarm_schedules',
    'room_context_settings', 'bedroom_settings'] as const
  const policies = Object.fromEntries(tables.map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid LIMIT 1001`).all()]))
  if (Object.values(policies).some(rows => rows.length > 1000)) throw rejectArrangementTransition()
  const state = {
    version: 1,
    household: database.prepare('SELECT id, pod_id, mode, source_side, revision, assignment_revision, effective_at FROM households WHERE id = ?').get(householdId),
    controls: readArrangementArchive(database), policies,
    device: database.prepare(`SELECT id, bed_mode, unused_zone_mode, default_schedule_end_action, timezone,
      reboot_daily, reboot_time, prime_pod_daily, prime_pod_time, global_max_on_hours, autopilot_enabled,
      led_night_mode_enabled, led_day_brightness, led_night_brightness, led_night_start_time, led_night_end_time,
      pump_stall_protection_enabled, pump_stall_rpm_threshold, pump_stall_dwell_samples,
      pump_stall_auto_recovery_enabled, pump_stall_recovery_rpm, pump_stall_recovery_samples
      FROM device_settings ORDER BY id`).all(),
  }
  if (!state.household || Buffer.byteLength(JSON.stringify(state)) > 4 * 1024 * 1024) throw rejectArrangementTransition()
  return arrangementDigest(state)
}
