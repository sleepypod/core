import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

// ============================================================================
// Device Settings & Configuration
// ============================================================================

export const deviceSettings = sqliteTable('device_settings', {
  id: integer('id').primaryKey().$defaultFn(() => 1), // Singleton
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  temperatureUnit: text('temperature_unit', { enum: ['F', 'C'] })
    .notNull()
    .default('F'),
  rebootDaily: integer('reboot_daily', { mode: 'boolean' })
    .notNull()
    .default(false),
  rebootTime: text('reboot_time').default('03:00'), // HH:mm format
  primePodDaily: integer('prime_pod_daily', { mode: 'boolean' })
    .notNull()
    .default(false),
  primePodTime: text('prime_pod_time').default('14:00'), // HH:mm format
  ledNightModeEnabled: integer('led_night_mode_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  ledDayBrightness: integer('led_day_brightness').notNull().default(100), // 0-100
  ledNightBrightness: integer('led_night_brightness').notNull().default(0), // 0-100
  ledNightStartTime: text('led_night_start_time').default('22:00'), // HH:mm format
  ledNightEndTime: text('led_night_end_time').default('07:00'), // HH:mm format
  // Global wall-clock safety cap: if a side has been powered for this many
  // hours with no run-once or always-on override, autoOffWatcher forces it
  // off. NULL = disabled. Independent of per-side bed-exit auto-off.
  globalMaxOnHours: integer('global_max_on_hours'),
  // MQTT bridge configuration. NULL on every field falls back to the
  // matching MQTT_* env var; a non-null value overrides the env. Plaintext
  // credentials per ADR 0019 — pod runs LAN-isolated and there is no auth
  // middleware to gate a hashed-credential round-trip yet.
  mqttEnabled: integer('mqtt_enabled', { mode: 'boolean' }),
  mqttUrl: text('mqtt_url'),
  mqttUsername: text('mqtt_username'),
  mqttPassword: text('mqtt_password'),
  mqttTopicPrefix: text('mqtt_topic_prefix'),
  mqttHaDiscovery: integer('mqtt_ha_discovery', { mode: 'boolean' }),
  mqttTlsEnabled: integer('mqtt_tls_enabled', { mode: 'boolean' }),
  // When true, accept self-signed broker certs (sets rejectUnauthorized:false).
  // Defaults to NULL (env fallback MQTT_TLS_INSECURE, then false). Off-by-default
  // per ADR 0019 — tlsEnabled alone keeps strict cert verification.
  mqttTlsInsecure: integer('mqtt_tls_insecure', { mode: 'boolean' }),
  // HomeKit bridge is opt-in. When true, instrumentation publishes the
  // hap-nodejs bridge with HeaterCooler/OccupancySensor/Switch accessories.
  homekitEnabled: integer('homekit_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  // Pump-stall safety guard (ADR 0022): a side whose pump RPM stays under the
  // trip threshold for dwellSamples consecutive frames is powered off until the
  // user re-enables it. Opt-in (default off) — it acts on flow/RPM data that
  // not all pods report consistently, and a power-cutting feature must not fire
  // on missing data. Auto-recovery is separately opt-in.
  pumpStallProtectionEnabled: integer('pump_stall_protection_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  pumpStallRpmThreshold: integer('pump_stall_rpm_threshold').notNull().default(500),
  pumpStallDwellSamples: integer('pump_stall_dwell_samples').notNull().default(2),
  pumpStallAutoRecoveryEnabled: integer('pump_stall_auto_recovery_enabled', { mode: 'boolean' })
    .notNull()
    .default(false),
  pumpStallRecoveryRpm: integer('pump_stall_recovery_rpm').notNull().default(1500),
  pumpStallRecoverySamples: integer('pump_stall_recovery_samples').notNull().default(3),
  // Autopilot global kill-switch. When false, the AutomationEngine evaluates
  // nothing and commands no hardware — per-rule enabled/dryRun state is
  // preserved, so flipping this back on resumes every rule as it was. Persisted
  // so the kill-switch survives reboot.
  autopilotEnabled: integer('autopilot_enabled', { mode: 'boolean' })
    .notNull()
    .default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const sideSettings = sqliteTable('side_settings', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  name: text('name').notNull(), // Must be provided explicitly during insert
  awayMode: integer('away_mode', { mode: 'boolean' }).notNull().default(false),
  alwaysOn: integer('always_on', { mode: 'boolean' }).notNull().default(false),
  autoOffEnabled: integer('auto_off_enabled', { mode: 'boolean' }).notNull().default(false),
  autoOffMinutes: integer('auto_off_minutes').notNull().default(30),
  awayStart: text('away_start'), // ISO datetime when away mode activates
  awayReturn: text('away_return'), // ISO datetime when away mode deactivates
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

export const tapGestures = sqliteTable('tap_gestures', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  tapType: text('tap_type', {
    enum: ['doubleTap', 'tripleTap', 'quadTap'],
  }).notNull(),
  actionType: text('action_type', { enum: ['temperature', 'alarm'] }).notNull(),
  // For temperature actions
  temperatureChange: text('temperature_change', {
    enum: ['increment', 'decrement'],
  }),
  temperatureAmount: integer('temperature_amount'), // 0-10
  // For alarm actions
  alarmBehavior: text('alarm_behavior', { enum: ['snooze', 'dismiss'] }),
  alarmSnoozeDuration: integer('alarm_snooze_duration'), // 60-600 seconds
  alarmInactiveBehavior: text('alarm_inactive_behavior', {
    enum: ['power', 'none'],
  }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  uniqueIndex('uq_tap_side_type').on(t.side, t.tapType),
])

// ============================================================================
// Schedules
// ============================================================================

export const temperatureSchedules = sqliteTable('temperature_schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  dayOfWeek: text('day_of_week', {
    enum: [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ],
  }).notNull(),
  time: text('time').notNull(), // HH:mm format
  temperature: real('temperature').notNull(), // 55-110°F
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  index('idx_temp_schedules_side_day_time').on(t.side, t.dayOfWeek, t.time),
])

export const powerSchedules = sqliteTable('power_schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  dayOfWeek: text('day_of_week', {
    enum: [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ],
  }).notNull(),
  onTime: text('on_time').notNull(), // HH:mm format
  offTime: text('off_time').notNull(), // HH:mm format
  onTemperature: real('on_temperature').notNull(), // Temperature when powered on
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  index('idx_power_schedules_side_day').on(t.side, t.dayOfWeek),
])

export const alarmSchedules = sqliteTable('alarm_schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  dayOfWeek: text('day_of_week', {
    enum: [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday',
    ],
  }).notNull(),
  time: text('time').notNull(), // HH:mm format
  vibrationIntensity: integer('vibration_intensity').notNull(), // 1-100
  vibrationPattern: text('vibration_pattern', { enum: ['double', 'rise'] })
    .notNull()
    .default('rise'),
  duration: integer('duration').notNull(), // 0-180 seconds
  alarmTemperature: real('alarm_temperature').notNull(), // Temperature during alarm
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  index('idx_alarm_schedules_side_day').on(t.side, t.dayOfWeek),
])

// ============================================================================
// Device State (Runtime)
// ============================================================================

export const deviceState = sqliteTable('device_state', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  currentTemperature: real('current_temperature'), // Current temp in °F
  targetTemperature: real('target_temperature'), // Target temp in °F
  isPowered: integer('is_powered', { mode: 'boolean' }).notNull().default(false),
  isAlarmVibrating: integer('is_alarm_vibrating', { mode: 'boolean' })
    .notNull()
    .default(false),
  waterLevel: text('water_level', { enum: ['low', 'ok', 'unknown'] }).default(
    'unknown'
  ),
  poweredOnAt: integer('powered_on_at', { mode: 'timestamp' }), // Set when power transitions OFF→ON, cleared ON→OFF
  lastUpdated: integer('last_updated', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ============================================================================
// System Health & Services
// ============================================================================

export const systemHealth = sqliteTable('system_health', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  component: text('component').notNull().unique(), // e.g., 'express', 'database', 'franken'
  status: text('status', {
    enum: ['healthy', 'degraded', 'down', 'unknown'],
  })
    .notNull()
    .default('unknown'),
  message: text('message'),
  lastChecked: integer('last_checked', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

// ============================================================================
// Run-Once Sessions (one-off curve application)
// ============================================================================

export const runOnceSessions = sqliteTable('run_once_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  setPoints: text('set_points').notNull(), // JSON: [{"time":"22:15","temperature":82}, ...]
  wakeTime: text('wake_time').notNull(), // HH:mm
  startedAt: integer('started_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  status: text('status', { enum: ['active', 'completed', 'cancelled'] })
    .notNull()
    .default('active'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  index('idx_run_once_side_status').on(t.side, t.status),
])

// ============================================================================
// Autopilot — reactive automations (WHEN / IF / THEN rules engine)
// ============================================================================

export const automations = sqliteTable('automations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  // null side = system/both; left/right scopes the rule to one side
  side: text('side', { enum: ['left', 'right'] }),
  priority: integer('priority').notNull().default(0),
  // When true the rule never touches hardware — it logs would-fire events and
  // emits notify actions only. The safe default for a freshly-built rule.
  dryRun: integer('dry_run', { mode: 'boolean' }).notNull().default(true),
  cooldownMin: integer('cooldown_min'),
  // Rule "AST" as JSON, validated by the zod schemas in validation-schemas.ts.
  trigger: text('trigger', { mode: 'json' }).notNull(),
  conditions: text('conditions', { mode: 'json' }).notNull(), // AND/OR/NOT tree
  actions: text('actions', { mode: 'json' }).notNull(), // expression-param actions
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  index('idx_automations_enabled').on(t.enabled),
])

export const automationRuns = sqliteTable('automation_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  automationId: integer('automation_id')
    .notNull()
    .references(() => automations.id, { onDelete: 'cascade' }),
  firedAt: integer('fired_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  outcome: text('outcome', {
    enum: ['fired', 'skipped', 'clamped', 'dry_run', 'error'],
  }).notNull(),
  detail: text('detail', { mode: 'json' }), // evaluated values + action result
}, t => [
  index('idx_automation_runs_automation_fired').on(t.automationId, t.firedAt),
])

// Indexes are now defined inline within each table definition above using index()
// This ensures Drizzle Kit generates them in migrations
