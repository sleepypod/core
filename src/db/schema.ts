import { sql } from 'drizzle-orm'
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { DayOfWeek } from '@/src/lib/scheduleTime'

// Source snapshots are server-created. Owner confirmation is distinct from sensor/command evidence.
export const comfortOwnerReviews = sqliteTable('comfort_owner_reviews', {
  id: text('id').primaryKey(), side: text('side').notNull(), createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(), review: text('review').notNull(), consumedAt: integer('consumed_at'),
}, table => [index('comfort_owner_reviews_expiry').on(table.expiresAt)])
export const comfortQualifications = sqliteTable('comfort_qualifications', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }), id: text('id').notNull().unique(),
  side: text('side').notNull(), kind: text('kind').notNull(), record: text('record').notNull(),
}, table => [index('comfort_qualifications_side_kind').on(table.side, table.kind, table.sequence)])
export const comfortActivations = sqliteTable('comfort_activations', {
  id: text('id').primaryKey(), side: text('side').notNull(), createdAt: integer('created_at').notNull(),
  snapshot: text('snapshot').notNull(), revokedAt: integer('revoked_at'), reason: text('reason'),
}, table => [index('comfort_activations_side').on(table.side, table.createdAt)])
export const comfortResolutions = sqliteTable('comfort_resolutions', {
  id: text('id').primaryKey(), side: text('side').notNull(), createdAt: integer('created_at').notNull(),
  snapshot: text('snapshot').notNull(), note: text('note').notNull(),
})

// Attempted commands are separate from proposals and firmware-reported sensor state.
export const temperatureApplications = sqliteTable('temperature_applications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  attemptId: text('attempt_id').notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  attemptedAt: integer('attempted_at').notNull(),
  finishedAt: integer('finished_at'),
  outcome: text('outcome', { enum: ['attempting', 'acknowledged', 'unknown'] }).notNull(),
  request: text('request').notNull(),
}, table => [
  uniqueIndex('temperature_applications_attempt').on(table.attemptId),
  index('temperature_applications_side_id').on(table.side, table.id),
  index('temperature_applications_retention').on(table.attemptedAt),
])

export const roomContextSettings = sqliteTable('room_context_settings', {
  id: integer('id').primaryKey(), revision: integer('revision').notNull(), config: text('config').notNull(),
})

// Bedroom sources retain physical-device identity; separate integrations cannot cast duplicate votes.
export const bedroomSettings = sqliteTable('bedroom_settings', {
  id: integer('id').primaryKey(), revision: integer('revision').notNull(), config: text('config').notNull(),
})
export const bedroomLatest = sqliteTable('bedroom_latest', {
  sourceId: text('source_id').primaryKey(), revision: integer('revision').notNull(),
  observedAt: integer('observed_at').notNull(), receivedAt: integer('received_at').notNull(),
  lastMeasuredAt: integer('last_measured_at'), report: text('report').notNull(),
})
export const bedroomHistory = sqliteTable('bedroom_history', {
  id: integer('id').primaryKey({ autoIncrement: true }), revision: integer('revision').notNull(),
  sourceId: text('source_id').notNull(), receivedAt: integer('received_at').notNull(),
  source: text('source').notNull(), report: text('report').notNull(),
}, table => [index('bedroom_history_received').on(table.receivedAt), index('bedroom_history_source').on(table.sourceId, table.id)])
export const roomContextLatest = sqliteTable('room_context_latest', {
  metric: text('metric').primaryKey(), revision: integer('revision').notNull(),
  measuredAt: integer('measured_at'), lastMeasuredAt: integer('last_measured_at'),
  reportedAt: integer('reported_at').notNull(), receivedAt: integer('received_at').notNull(),
  value: real('value'), available: integer('available').notNull(),
})
export const roomContextHistory = sqliteTable('room_context_history', {
  id: integer('id').primaryKey({ autoIncrement: true }), revision: integer('revision').notNull(),
  metric: text('metric').notNull(), entityId: text('entity_id').notNull(), unit: text('unit').notNull(),
  measuredAt: integer('measured_at'), reportedAt: integer('reported_at').notNull(), receivedAt: integer('received_at').notNull(),
  value: real('value'), available: integer('available').notNull(),
}, table => [index('room_context_history_received').on(table.receivedAt)])

/** Owner-visible automation alerts. Acknowledgment is separate from delivery. */
export const notificationInbox = sqliteTable('notification_inbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: integer('source_id').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  acknowledgedAt: integer('acknowledged_at'),
}, table => [
  index('notification_inbox_fingerprint_created').on(table.fingerprint, table.createdAt),
  index('notification_inbox_created').on(table.createdAt),
])

// Kept across restarts: an interrupted actuator request must never be replayed.
export const controlReceipts = sqliteTable('control_receipts', {
  requestId: text('request_id').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  request: text('request').notNull(),
  state: text('state', { enum: ['executing', 'acknowledged', 'not_dispatched', 'rejected', 'expired', 'unknown'] }).notNull(),
  reason: text('reason'),
  receivedAt: integer('received_at').notNull(),
  finishedAt: integer('finished_at'),
  dispatchCount: integer('dispatch_count').notNull().default(0),
  lastDispatchAt: integer('last_dispatch_at'),
  runId: text('run_id').notNull(),
}, table => [index('control_receipts_received_idx').on(table.receivedAt)])

// ============================================================================
// Device Settings & Configuration
// ============================================================================

export const deviceSettings = sqliteTable('device_settings', {
  id: integer('id').primaryKey().$defaultFn(() => 1), // Singleton
  bedMode: text('bed_mode', { enum: ['two', 'solo-left', 'solo-right'] }).notNull().default('two'),
  unusedZoneMode: text('unused_zone_mode', { enum: ['follow', 'off', 'independent'] }).notNull().default('off'),
  defaultScheduleEndAction: text('default_schedule_end_action', { enum: ['turn_off', 'maintain'] }).notNull().default('turn_off'),
  timezone: text('timezone').notNull().default('America/Los_Angeles'),
  temperatureUnit: text('temperature_unit', { enum: ['F', 'C'] })
    .notNull()
    .default('F'),
  timeFormat: text('time_format', { enum: ['12h', '24h'] })
    .notNull()
    .default('12h'),
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
    .default(false),
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
  // Experimental: power the side on once a person has been in bed for
  // auto_on_minutes, inside the auto_on_start..auto_on_end local-time window
  // (wraps midnight; equal times mean any time). See services/autoOnWatcher.
  autoOnEnabled: integer('auto_on_enabled', { mode: 'boolean' }).notNull().default(false),
  autoOnMinutes: integer('auto_on_minutes').notNull().default(5),
  autoOnStart: text('auto_on_start').notNull().default('20:00'),
  autoOnEnd: text('auto_on_end').notNull().default('08:00'),
  awayStart: text('away_start'), // ISO datetime when away mode activates
  awayReturn: text('away_return'), // ISO datetime when away mode deactivates
  // Sleep stage classifier ({ engine, ruleset }), validated by
  // stageClassifierSchema; null classifies with the defaults.
  stageClassifier: text('stage_classifier', { mode: 'json' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
})

/**
 * Every save of a side's sleep stage classifier, so the editor can list
 * recent changes with their effect and revert one. `before`/`after` are
 * classifiers ({ engine, ruleset }) or null for the defaults.
 */
export const stageClassifierChanges = sqliteTable('stage_classifier_changes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  changedAt: integer('changed_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  before: text('before', { mode: 'json' }),
  after: text('after', { mode: 'json' }),
  // "Wake movement 200 → 240 +2 more"
  summary: text('summary').notNull(),
  // Agreement with reference stages (0–1) on the latest night, before and
  // after the change; null when that night has no reference stages.
  agreementBefore: real('agreement_before'),
  agreementAfter: real('agreement_after'),
}, t => [
  index('idx_stage_classifier_changes_side_changed_at').on(t.side, t.changedAt),
])

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
  // Retained for migration; the runtime snooze length now lives in alarm_schedules.
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

/** Bedtime ownership keeps a night's phases together while scheduler rows remain calendar events. */
export const bedtimeRoutines = sqliteTable('bedtime_routines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  dayOfWeek: text('day_of_week', { enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] }).notNull(),
  configuration: text('configuration').notNull(),
  scheduleIds: text('schedule_ids').notNull(),
}, table => [uniqueIndex('idx_bedtime_routines_side_day').on(table.side, table.dayOfWeek)])

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

/**
 * Optional note for a side's curve on one day. A curve is the set of days
 * sharing set points, so saving a curve writes the same note to each of its
 * days; the Schedule screen shows the first day's.
 */
export const scheduleNotes = sqliteTable('schedule_notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  dayOfWeek: text('day_of_week', {
    enum: ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'],
  }).notNull(),
  notes: text('notes').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  uniqueIndex('idx_schedule_notes_side_day').on(t.side, t.dayOfWeek),
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
  offTime: text('off_time').notNull(), // Curve end time; retained when maintaining temperature
  // Existing Core rows are calendar-day events. Imports can explicitly end the next day.
  offDayOffset: integer('off_day_offset').notNull().default(0),
  endAction: text('end_action', { enum: ['turn_off', 'maintain'] }).notNull().default('turn_off'),
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
  // Minutes before `time` in which movement fires the alarm early; 0 = off.
  wakeWindow: integer('wake_window').notNull().default(0),
  // How long a snooze lasts (seconds), and Snooze taper: each later snooze of
  // the same alarm is this percent shorter (0 = off). Tap gestures and the
  // HomeKit switch snooze with these.
  snoozeDuration: integer('snooze_duration').notNull().default(300),
  snoozeTaper: integer('snooze_taper').notNull().default(0),
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

export const temperatureHolds = sqliteTable('temperature_holds', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  temperature: real('temperature').notNull(),
  // Epoch milliseconds preserve the exact hold boundary across restarts.
  startedAt: integer('started_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

/** Personal comfort records are separate from the shared controller's holds. */
export const comfortStates = sqliteTable('comfort_states', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  state: text('state', { mode: 'json' }).notNull(),
})

/** Fitted local comfort models retain their training provenance and held-out evaluation. */
export const comfortModels = sqliteTable('comfort_models', {
  id: text('id').primaryKey(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  datasetHash: text('dataset_hash').notNull(),
  record: text('record', { mode: 'json' }).notNull(),
}, table => [index('idx_comfort_models_side_created').on(table.side, table.createdAt)])

/** Water-response forecasts have a separate registry from morning comfort classifiers. */
export const thermalForecasts = sqliteTable('thermal_forecasts', {
  id: text('id').primaryKey(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  createdAt: integer('created_at').notNull(),
  record: text('record', { mode: 'json' }).notNull(),
}, table => [index('idx_thermal_forecasts_side_created').on(table.side, table.createdAt)])

export const comfortFeedback = sqliteTable('comfort_feedback', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  localDate: text('local_date').notNull(),
  comfort: text('comfort', { enum: ['warm', 'cold', 'comfortable'] }).notNull(),
  recordedAt: integer('recorded_at').notNull(), // Epoch milliseconds
}, table => [uniqueIndex('uq_comfort_feedback_side_date').on(table.side, table.localDate)])

/** Deleted check-ins retain only a revision, preventing a stale client from resurrecting private notes. */
export const journalEntries = sqliteTable('journal_entries', {
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  localDate: text('local_date').notNull(),
  revision: text('revision').notNull(),
  record: text('record', { mode: 'json' }),
}, table => [uniqueIndex('uq_journal_entries_side_date').on(table.side, table.localDate)])

/** Append-only owner reviews bind to an exact retained Preview report. */
export const comfortReviews = sqliteTable('comfort_reviews', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  reportId: text('report_id').notNull(),
  createdAt: integer('created_at').notNull(),
  review: text('review', { mode: 'json' }).notNull(),
  snapshot: text('snapshot', { mode: 'json' }).notNull(),
}, table => [index('idx_comfort_reviews_side_report').on(table.side, table.reportId, table.id)])

export const comfortEvents = sqliteTable('comfort_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  observedAt: integer('observed_at').notNull(), // Epoch milliseconds
  event: text('event', { mode: 'json' }).notNull(),
  reportId: text('report_id'),
}, table => [index('idx_comfort_events_side_time').on(table.side, table.observedAt),
  index('idx_comfort_events_side_report').on(table.side, table.reportId, table.id)])

export const deviceState = sqliteTable('device_state', {
  // Explicit manual hardware cutoff, independent of temperature ownership (epoch ms).
  hardwareDeadline: integer('hardware_deadline'),
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
// Saved curves (named set point lists, not tied to any day or side)
// ============================================================================

export const curveTemplates = sqliteTable('curve_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  bedtime: text('bedtime').notNull(), // HH:mm
  wake: text('wake').notNull(), // HH:mm
  points: text('points', { mode: 'json' }).notNull().$type<Record<string, number>>(), // {"HH:mm": tempF}
  // Column predates the notes name (it held the AI wizard's reasoning).
  notes: text('reasoning').notNull().default(''),
  endAction: text('end_action', { enum: ['turn_off', 'maintain'] }).notNull().default('turn_off'),
  // Days the curve runs on per side. While active, no other active curve
  // claims the same side and day, and that day's temperature and power rows
  // are this curve's (src/server/scheduleLibrary.ts).
  leftDays: text('left_days', { mode: 'json' }).notNull().$type<DayOfWeek[]>().default(sql`'[]'`),
  rightDays: text('right_days', { mode: 'json' }).notNull().$type<DayOfWeek[]>().default(sql`'[]'`),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
}, t => [
  uniqueIndex('idx_curve_templates_name').on(t.name),
])

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

// Side-aware schedules; synchronized transports only accept both sides.
export const baseSchedules = sqliteTable('base_schedules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dayOfWeek: text('day_of_week', { enum: ['daily', 'weekdays', 'weekends', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] }).notNull(),
  side: text('side', { enum: ['both', 'left', 'right'] }).notNull().default('both'),
  presetName: text('preset_name').notNull().default('Custom'),
  time: text('time').notNull(),
  head: integer('head').notNull(),
  feet: integer('feet').notNull(),
  feedRate: integer('feed_rate').notNull().default(50),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
}, table => [uniqueIndex('base_schedules_day_time_side').on(table.dayOfWeek, table.time, table.side)])

// Biometric algorithm personalization is configuration, not sensor calibration.
// Immutable revisions survive biometric-history resets and artifact retention.
export const biometricProfileRevisions = sqliteTable('biometric_profile_revisions', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull(),
  revision: integer('revision').notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  baseManifestHash: text('base_manifest_hash').notNull(),
  baseManifest: text('base_manifest', { mode: 'json' }).notNull(),
  overrides: text('overrides', { mode: 'json' }).notNull(),
  resolved: text('resolved', { mode: 'json' }).notNull(),
  resolvedHash: text('resolved_hash').notNull(),
  dependencyHashes: text('dependency_hashes', { mode: 'json' }).notNull(),
  parentRevisionId: text('parent_revision_id'),
  origin: text('origin', { enum: ['manual', 'migration', 'agent', 'system'] }).notNull(),
  requester: text('requester').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, t => [
  uniqueIndex('uq_biometric_profile_family_revision').on(t.familyId, t.revision),
  uniqueIndex('uq_biometric_profile_idempotency').on(t.idempotencyKey),
  index('idx_biometric_profile_side_created').on(t.side, t.createdAtMs),
])

export const biometricProfileBindings = sqliteTable('biometric_profile_bindings', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  desiredRevisionId: text('desired_revision_id'), // null follows current shipped default
  generation: integer('generation').notNull(),
  previousRevisionId: text('previous_revision_id'),
  updatedAtMs: integer('updated_at_ms').notNull(),
})

export const biometricActivationEvents = sqliteTable('biometric_activation_events', {
  id: text('id').primaryKey(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  generation: integer('generation').notNull(),
  action: text('action', { enum: ['activate', 'reset', 'rollback', 'migration', 'fallback'] }).notNull(),
  previousRevisionId: text('previous_revision_id'),
  nextRevisionId: text('next_revision_id'),
  previousHash: text('previous_hash').notNull(),
  nextHash: text('next_hash').notNull(),
  evaluationId: text('evaluation_id'),
  evidence: text('evidence', { mode: 'json' }).notNull(),
  requester: text('requester').notNull(),
  state: text('state', { enum: ['saved', 'pending_delivery', 'pending_boundary', 'applied', 'failed'] }).notNull(),
  reason: text('reason'),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, t => [
  uniqueIndex('uq_biometric_activation_generation').on(t.side, t.generation),
  uniqueIndex('uq_biometric_activation_idempotency').on(t.idempotencyKey),
])

export const biometricConfigOutbox = sqliteTable('biometric_config_outbox', {
  id: text('id').primaryKey(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  generation: integer('generation').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  resolvedHash: text('resolved_hash').notNull(),
  state: text('state', { enum: ['pending', 'delivered', 'failed'] }).notNull(),
  attempts: integer('attempts').notNull().default(0),
  nextAttemptAtMs: integer('next_attempt_at_ms').notNull(),
  lastError: text('last_error'),
  createdAtMs: integer('created_at_ms').notNull(),
  deliveredAtMs: integer('delivered_at_ms'),
}, t => [
  uniqueIndex('uq_biometric_outbox_generation').on(t.side, t.generation),
  index('idx_biometric_outbox_pending').on(t.state, t.nextAttemptAtMs),
])

export const sideStageModels = sqliteTable('side_stage_models', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  model: text('model', { mode: 'json' }).notNull(),
  version: text('version').notNull(),
  modelHash: text('model_hash').notNull(),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
  // When set, the side's stages are classified by this model instead of the profile's rules; the rules
  // remain the fallback whenever the model cannot stage a night.
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
})

/** Saved candidates; the legacy per-side row remains the selected model for existing clients. */
export const stageModelLibrary = sqliteTable('stage_model_library', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  model: text('model', { mode: 'json' }).notNull(),
  version: text('version').notNull(),
  modelHash: text('model_hash').notNull(),
  uploadedAt: integer('uploaded_at', { mode: 'timestamp' }).notNull(),
}, table => [index('stage_model_library_side_idx').on(table.side), uniqueIndex('stage_model_library_side_hash').on(table.side, table.modelHash)])

// Temporary wake changes never rewrite alarm_schedules. Null records retain a
// generation after restore so stale clients cannot replay a prior change.
export const alarmOverrides = sqliteTable('alarm_overrides', {
  side: text('side', { enum: ['left', 'right'] }).primaryKey(),
  revision: text('revision').notNull(),
  record: text('record'),
})

// One durable attempt per original weekly occurrence, shared by early wake,
// changed-time and normal callbacks. An unknown transport result is not retried.
export const alarmOccurrences = sqliteTable('alarm_occurrences', {
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  scheduleId: integer('schedule_id').notNull(),
  originalAt: integer('original_at').notNull(),
  effectiveAt: integer('effective_at').notNull(),
  outcome: text('outcome', { enum: ['attempting', 'acknowledged', 'unknown'] }).notNull(),
  attemptedAt: integer('attempted_at').notNull(),
}, table => [
  uniqueIndex('idx_alarm_occurrences_identity').on(table.side, table.scheduleId, table.originalAt),
  index('idx_alarm_occurrences_retention').on(table.attemptedAt),
])

// Identity is independent of a physical side. Initial membership prepares a
// private workspace; it does not activate another sleeper or rewrite schedules.
export const households = sqliteTable('households', {
  id: text('id').primaryKey(),
  podId: text('pod_id').notNull().unique(),
  setupRequestId: text('setup_request_id').notNull().unique(),
  revision: integer('revision').notNull().default(1),
  assignmentRevision: integer('assignment_revision').notNull().default(1),
  mode: text('mode', { enum: ['solo-anywhere', 'assigned'] }).notNull(),
  sourceSide: text('source_side', { enum: ['left', 'right'] }).notNull(),
  effectiveAt: integer('effective_at').notNull(),
})

export const householdAccounts = sqliteTable('household_accounts', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id),
  sleeperId: text('sleeper_id').notNull().unique(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['owner', 'member'] }).notNull(),
  state: text('state', { enum: ['active', 'revoked'] }).notNull().default('active'),
  assignedSide: text('assigned_side', { enum: ['left', 'right'] }),
  sessionRevision: integer('session_revision').notNull().default(1),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('idx_household_assigned_side').on(table.householdId, table.assignedSide)])

export const householdDevices = sqliteTable('household_devices', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => householdAccounts.id),
  tokenHash: text('token_hash').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
})

export const householdInvitations = sqliteTable('household_invitations', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id),
  issuerId: text('issuer_id').notNull().references(() => householdAccounts.id),
  kind: text('kind', { enum: ['new_person', 'own_device'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  targetAccountId: text('target_account_id').references(() => householdAccounts.id),
  claimedDeviceId: text('claimed_device_id').references(() => householdDevices.id),
  expiresAt: integer('expires_at').notNull(),
  revokedAt: integer('revoked_at'),
})

export const householdPersonalSettings = sqliteTable('household_personal_settings', {
  accountId: text('account_id').primaryKey().references(() => householdAccounts.id),
  preferences: text('preferences').notNull(),
  preferencesRevision: integer('preferences_revision').notNull().default(1),
  routines: text('routines').notNull(),
  routinesRevision: integer('routines_revision').notNull().default(1),
})

export const householdMutationReceipts = sqliteTable('household_mutation_receipts', {
  requestId: text('request_id').primaryKey(),
  accountId: text('account_id').notNull().references(() => householdAccounts.id),
  kind: text('kind').notNull(),
  requestHash: text('request_hash').notNull(),
  result: text('result').notNull(),
  createdAt: integer('created_at').notNull(),
})

// An inert shared-arrangement review, with independently approved private plans.
// Creating or approving it never changes physical assignments or live routines.
export const householdArrangementReviews = sqliteTable('household_arrangement_reviews', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id),
  creatorAccountId: text('creator_account_id').notNull().references(() => householdAccounts.id),
  requestHash: text('request_hash').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  state: text('state', { enum: ['open', 'cancelled', 'consumed'] }).notNull().default('open'),
}, table => [index('idx_household_arrangement_reviews').on(table.householdId, table.createdAt)])

export const householdArrangementApprovals = sqliteTable('household_arrangement_approvals', {
  requestId: text('request_id').primaryKey(),
  reviewId: text('review_id').notNull().references(() => householdArrangementReviews.id),
  accountId: text('account_id').notNull().references(() => householdAccounts.id),
  deviceId: text('device_id').notNull().references(() => householdDevices.id),
  requestHash: text('request_hash').notNull(),
  createdAt: integer('created_at').notNull(),
}, table => [uniqueIndex('idx_household_arrangement_approval').on(table.reviewId, table.accountId)])

// Persist the latest browser identity independently of response arrival order.
// Only hashes are retained; this table cannot recreate a browser credential.
export const householdBrowserScopes = sqliteTable('household_browser_scopes', {
  keyHash: text('key_hash').primaryKey(),
  kind: text('kind', { enum: ['owner', 'personal', 'signed_out'] }).notNull(),
  sessionHash: text('session_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),
})

// This one-way boundary outlives account revocation and arrangement changes.
// It has no household foreign key: deleting membership must not reopen exports.
export const householdPrivacyBoundary = sqliteTable('household_privacy_boundary', {
  id: integer('id').primaryKey(),
  requiredAt: integer('required_at').notNull(),
  reason: text('reason').notNull(),
})

// Reviewed source intervals describe attribution, not physical sensor identity.
// They never change the hardware arrangement or claim old rows during signup.
export const householdHistoryState = sqliteTable('household_history_state', {
  householdId: text('household_id').primaryKey().references(() => households.id),
  attributionRevision: integer('attribution_revision').notNull().default(1),
})

export const householdAttributionEpochs = sqliteTable('household_attribution_epochs', {
  id: text('id').primaryKey(),
  householdId: text('household_id').notNull().references(() => households.id),
  datasetId: text('dataset_id').notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at'),
  mode: text('mode', { enum: ['solo_merged', 'assigned'] }).notNull(),
  assignments: text('assignments').notNull(),
  basis: text('basis', { enum: ['legacy_owner_review', 'verified_arrangement'] }).notNull(),
  reviewReceiptId: text('review_receipt_id').notNull().unique(),
  reviewedBy: text('reviewed_by').notNull().references(() => householdAccounts.id),
  requestHash: text('request_hash').notNull(),
  createdAt: integer('created_at').notNull(),
  revokedAt: integer('revoked_at'),
}, table => [index('idx_household_attribution_time').on(table.householdId, table.datasetId, table.startsAt)])

export const householdPersonRecords = sqliteTable('household_person_records', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  householdId: text('household_id').notNull().references(() => households.id),
  sleeperId: text('sleeper_id').notNull().references(() => householdAccounts.sleeperId),
  epochId: text('epoch_id').notNull().references(() => householdAttributionEpochs.id),
  datasetId: text('dataset_id').notNull(),
  sourceKind: text('source_kind', { enum: ['presence', 'vitals', 'movement'] }).notNull(),
  sourceRecordKey: text('source_record_key').notNull(),
  contentHash: text('content_hash').notNull(),
  recordedSide: text('recorded_side', { enum: ['left', 'right'] }).notNull(),
  startsAt: integer('starts_at').notNull(),
  endsAt: integer('ends_at').notNull(),
  payload: text('payload').notNull(),
  createdAt: integer('created_at').notNull(),
  invalidatedAt: integer('invalidated_at'),
}, table => [
  uniqueIndex('idx_household_source_record').on(table.datasetId, table.sourceKind, table.sourceRecordKey),
  index('idx_household_person_history').on(table.householdId, table.sleeperId, table.startsAt),
])

// Personal command receipts never enter the legacy owner-visible control table.
export const householdControlReceipts = sqliteTable('household_control_receipts', {
  requestId: text('request_id').primaryKey(),
  accountId: text('account_id').notNull().references(() => householdAccounts.id),
  personalRequest: text('personal_request').notNull(),
  resolvedZones: text('resolved_zones').notNull(),
  fingerprint: text('fingerprint').notNull(),
  request: text('request').notNull(),
  state: text('state', { enum: ['executing', 'acknowledged', 'not_dispatched', 'rejected', 'expired', 'unknown'] }).notNull(),
  reason: text('reason'),
  receivedAt: integer('received_at').notNull(),
  finishedAt: integer('finished_at'),
  dispatchCount: integer('dispatch_count').notNull().default(0),
  lastDispatchAt: integer('last_dispatch_at'),
  runId: text('run_id').notNull(),
}, table => [index('idx_household_control_account').on(table.accountId, table.receivedAt)])
