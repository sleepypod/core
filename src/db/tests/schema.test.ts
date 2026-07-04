import { is, SQL } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import { describe, expect, it } from 'vitest'
import * as schema from '../schema'

// These tests pin the drizzle table definitions in schema.ts: table names,
// the full ordered column list, each column's nullability + default, and every
// index (name, uniqueness, columns). They read the schema objects directly via
// getTableConfig — NOT the generated migration SQL — so a change to a column
// name, a flipped boolean/string default, or a dropped index in schema.ts fails
// here even though the static migrations under src/db/migrations are untouched.

// Default descriptor: collapses a column's default into something comparable.
//   undefined  -> no default at all (hasDefault === false)
//   'sql'      -> SQL expression default, e.g. sql`(unixepoch())`
//   'fn'       -> JS $defaultFn() default (drizzle exposes hasDefault but no value)
//   <value>    -> a literal string / number / boolean default
type DefaultDescriptor = undefined | 'sql' | 'fn' | string | number | boolean

interface ColumnSpec {
  name: string
  notNull: boolean
  default: DefaultDescriptor
}

interface IndexSpec {
  name: string
  unique: boolean
  columns: string[]
}

interface TableSpec {
  name: string
  columns: ColumnSpec[]
  indexes: IndexSpec[]
}

function describeColumn(c: ReturnType<typeof getTableConfig>['columns'][number]): ColumnSpec {
  let dflt: DefaultDescriptor
  if (!c.hasDefault) {
    dflt = undefined
  }
  else if (is(c.default, SQL)) {
    dflt = 'sql'
  }
  else if (c.default === undefined) {
    dflt = 'fn'
  }
  else {
    dflt = c.default as DefaultDescriptor
  }
  return { name: c.name, notNull: c.notNull, default: dflt }
}

function describeTable(table: SQLiteTable): TableSpec {
  const cfg = getTableConfig(table)
  return {
    name: cfg.name,
    columns: cfg.columns.map(describeColumn),
    indexes: cfg.indexes
      .map(i => ({
        name: i.config.name,
        unique: i.config.unique,
        columns: i.config.columns.map(col => (col as { name: string }).name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

const expectedTables: Record<string, TableSpec> = {
  deviceSettings: {
    name: 'device_settings',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'timezone', notNull: true, default: 'America/Los_Angeles' },
      { name: 'temperature_unit', notNull: true, default: 'F' },
      { name: 'reboot_daily', notNull: true, default: false },
      { name: 'reboot_time', notNull: false, default: '03:00' },
      { name: 'prime_pod_daily', notNull: true, default: false },
      { name: 'prime_pod_time', notNull: false, default: '14:00' },
      { name: 'led_night_mode_enabled', notNull: true, default: false },
      { name: 'led_day_brightness', notNull: true, default: 100 },
      { name: 'led_night_brightness', notNull: true, default: 0 },
      { name: 'led_night_start_time', notNull: false, default: '22:00' },
      { name: 'led_night_end_time', notNull: false, default: '07:00' },
      { name: 'global_max_on_hours', notNull: false, default: undefined },
      { name: 'mqtt_enabled', notNull: false, default: undefined },
      { name: 'mqtt_url', notNull: false, default: undefined },
      { name: 'mqtt_username', notNull: false, default: undefined },
      { name: 'mqtt_password', notNull: false, default: undefined },
      { name: 'mqtt_topic_prefix', notNull: false, default: undefined },
      { name: 'mqtt_ha_discovery', notNull: false, default: undefined },
      { name: 'mqtt_tls_enabled', notNull: false, default: undefined },
      { name: 'mqtt_tls_insecure', notNull: false, default: undefined },
      { name: 'homekit_enabled', notNull: true, default: false },
      { name: 'pump_stall_protection_enabled', notNull: true, default: false },
      { name: 'pump_stall_rpm_threshold', notNull: true, default: 500 },
      { name: 'pump_stall_dwell_samples', notNull: true, default: 2 },
      { name: 'pump_stall_auto_recovery_enabled', notNull: true, default: false },
      { name: 'pump_stall_recovery_rpm', notNull: true, default: 1500 },
      { name: 'pump_stall_recovery_samples', notNull: true, default: 3 },
      { name: 'autopilot_enabled', notNull: true, default: true },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [],
  },
  sideSettings: {
    name: 'side_settings',
    columns: [
      { name: 'side', notNull: true, default: undefined },
      { name: 'name', notNull: true, default: undefined },
      { name: 'away_mode', notNull: true, default: false },
      { name: 'always_on', notNull: true, default: false },
      { name: 'auto_off_enabled', notNull: true, default: false },
      { name: 'auto_off_minutes', notNull: true, default: 30 },
      { name: 'away_start', notNull: false, default: undefined },
      { name: 'away_return', notNull: false, default: undefined },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [],
  },
  tapGestures: {
    name: 'tap_gestures',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'side', notNull: true, default: undefined },
      { name: 'tap_type', notNull: true, default: undefined },
      { name: 'action_type', notNull: true, default: undefined },
      { name: 'temperature_change', notNull: false, default: undefined },
      { name: 'temperature_amount', notNull: false, default: undefined },
      { name: 'alarm_behavior', notNull: false, default: undefined },
      { name: 'alarm_snooze_duration', notNull: false, default: undefined },
      { name: 'alarm_inactive_behavior', notNull: false, default: undefined },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [
      { name: 'uq_tap_side_type', unique: true, columns: ['side', 'tap_type'] },
    ],
  },
  temperatureSchedules: {
    name: 'temperature_schedules',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'side', notNull: true, default: undefined },
      { name: 'day_of_week', notNull: true, default: undefined },
      { name: 'time', notNull: true, default: undefined },
      { name: 'temperature', notNull: true, default: undefined },
      { name: 'enabled', notNull: true, default: true },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [
      { name: 'idx_temp_schedules_side_day_time', unique: false, columns: ['side', 'day_of_week', 'time'] },
    ],
  },
  powerSchedules: {
    name: 'power_schedules',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'side', notNull: true, default: undefined },
      { name: 'day_of_week', notNull: true, default: undefined },
      { name: 'on_time', notNull: true, default: undefined },
      { name: 'off_time', notNull: true, default: undefined },
      { name: 'on_temperature', notNull: true, default: undefined },
      { name: 'enabled', notNull: true, default: true },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [
      { name: 'idx_power_schedules_side_day', unique: false, columns: ['side', 'day_of_week'] },
    ],
  },
  alarmSchedules: {
    name: 'alarm_schedules',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'side', notNull: true, default: undefined },
      { name: 'day_of_week', notNull: true, default: undefined },
      { name: 'time', notNull: true, default: undefined },
      { name: 'vibration_intensity', notNull: true, default: undefined },
      { name: 'vibration_pattern', notNull: true, default: 'rise' },
      { name: 'duration', notNull: true, default: undefined },
      { name: 'alarm_temperature', notNull: true, default: undefined },
      { name: 'enabled', notNull: true, default: true },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [
      { name: 'idx_alarm_schedules_side_day', unique: false, columns: ['side', 'day_of_week'] },
    ],
  },
  deviceState: {
    name: 'device_state',
    columns: [
      { name: 'side', notNull: true, default: undefined },
      { name: 'current_temperature', notNull: false, default: undefined },
      { name: 'target_temperature', notNull: false, default: undefined },
      { name: 'is_powered', notNull: true, default: false },
      { name: 'is_alarm_vibrating', notNull: true, default: false },
      { name: 'water_level', notNull: false, default: 'unknown' },
      { name: 'powered_on_at', notNull: false, default: undefined },
      { name: 'last_updated', notNull: true, default: 'sql' },
    ],
    indexes: [],
  },
  systemHealth: {
    name: 'system_health',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'component', notNull: true, default: undefined },
      { name: 'status', notNull: true, default: 'unknown' },
      { name: 'message', notNull: false, default: undefined },
      { name: 'last_checked', notNull: true, default: 'sql' },
    ],
    indexes: [],
  },
  runOnceSessions: {
    name: 'run_once_sessions',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'side', notNull: true, default: undefined },
      { name: 'set_points', notNull: true, default: undefined },
      { name: 'wake_time', notNull: true, default: undefined },
      { name: 'started_at', notNull: true, default: 'sql' },
      { name: 'expires_at', notNull: true, default: undefined },
      { name: 'status', notNull: true, default: 'active' },
      { name: 'created_at', notNull: true, default: 'sql' },
    ],
    indexes: [
      { name: 'idx_run_once_side_status', unique: false, columns: ['side', 'status'] },
    ],
  },
  automations: {
    name: 'automations',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'name', notNull: true, default: undefined },
      { name: 'enabled', notNull: true, default: true },
      { name: 'side', notNull: false, default: undefined },
      { name: 'priority', notNull: true, default: 0 },
      { name: 'dry_run', notNull: true, default: true },
      { name: 'cooldown_min', notNull: false, default: undefined },
      { name: 'trigger', notNull: true, default: undefined },
      { name: 'conditions', notNull: true, default: undefined },
      { name: 'actions', notNull: true, default: undefined },
      { name: 'created_at', notNull: true, default: 'sql' },
      { name: 'updated_at', notNull: true, default: 'sql' },
    ],
    indexes: [
      { name: 'idx_automations_enabled', unique: false, columns: ['enabled'] },
    ],
  },
  automationRuns: {
    name: 'automation_runs',
    columns: [
      { name: 'id', notNull: true, default: 'fn' },
      { name: 'automation_id', notNull: true, default: undefined },
      { name: 'fired_at', notNull: true, default: 'sql' },
      { name: 'outcome', notNull: true, default: undefined },
      { name: 'detail', notNull: false, default: undefined },
    ],
    indexes: [
      { name: 'idx_automation_runs_automation_fired', unique: false, columns: ['automation_id', 'fired_at'] },
    ],
  },
}

describe('db schema definitions', () => {
  for (const [exportName, expected] of Object.entries(expectedTables)) {
    it(`${exportName} matches its expected table/columns/indexes`, () => {
      const table = (schema as Record<string, SQLiteTable>)[exportName]
      expect(table, `schema.${exportName} should be exported`).toBeDefined()
      expect(describeTable(table)).toEqual(expected)
    })
  }

  it('exports exactly the expected set of tables', () => {
    const actualTableExports = Object.entries(schema)
      .filter(([, v]) => {
        try {
          getTableConfig(v as SQLiteTable)
          return true
        }
        catch {
          return false
        }
      })
      .map(([k]) => k)
      .sort()
    expect(actualTableExports).toEqual(Object.keys(expectedTables).sort())
  })
})
