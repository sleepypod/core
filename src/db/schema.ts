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

// Indexes are now defined inline within each table definition above using index()
// This ensures Drizzle Kit generates them in migrations
