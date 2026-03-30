import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

/**
 * Biometrics database schema — lives in biometrics.db, separate from the
 * main sleepypod.db config/state database.
 *
 * This schema IS the public contract for biometrics modules. Any module
 * (Python, Rust, etc.) that writes rows matching these shapes will work
 * automatically with the core app's tRPC biometrics API.
 *
 * Concurrency: biometrics.db is opened with WAL mode and a 5-second
 * busy_timeout. Multiple modules may write concurrently without conflicts
 * at typical write frequencies (~60s for vitals).
 */

export const vitals = sqliteTable('vitals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  heartRate: real('heart_rate'), // bpm — null if sensor data unreliable
  hrv: real('hrv'), // ms RMSSD
  breathingRate: real('breathing_rate'), // breaths/min
}, t => [
  index('idx_vitals_side_timestamp').on(t.side, t.timestamp),
  uniqueIndex('uq_vitals_side_timestamp').on(t.side, t.timestamp),
])

export const sleepRecords = sqliteTable('sleep_records', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  enteredBedAt: integer('entered_bed_at', { mode: 'timestamp' }).notNull(),
  leftBedAt: integer('left_bed_at', { mode: 'timestamp' }).notNull(),
  sleepDurationSeconds: integer('sleep_duration_seconds').notNull(),
  timesExitedBed: integer('times_exited_bed').notNull().default(0),
  presentIntervals: text('present_intervals', { mode: 'json' }), // [[start, end], ...]
  notPresentIntervals: text('not_present_intervals', { mode: 'json' }), // [[start, end], ...]
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .$defaultFn(() => new Date()),
}, t => [
  index('idx_sleep_records_side_entered').on(t.side, t.enteredBedAt),
])

export const movement = sqliteTable('movement', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  totalMovement: integer('total_movement').notNull(),
}, t => [
  index('idx_movement_side_timestamp').on(t.side, t.timestamp),
])

export const bedTemp = sqliteTable('bed_temp', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  ambientTemp: integer('ambient_temp'), // centidegrees C (u16)
  mcuTemp: integer('mcu_temp'), // centidegrees C (u16)
  humidity: integer('humidity'), // centipercent (u16)
  leftOuterTemp: integer('left_outer_temp'), // centidegrees C (u16)
  leftCenterTemp: integer('left_center_temp'),
  leftInnerTemp: integer('left_inner_temp'),
  rightOuterTemp: integer('right_outer_temp'),
  rightCenterTemp: integer('right_center_temp'),
  rightInnerTemp: integer('right_inner_temp'),
}, t => [
  uniqueIndex('idx_bed_temp_timestamp').on(t.timestamp),
])

export const freezerTemp = sqliteTable('freezer_temp', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  ambientTemp: integer('ambient_temp'), // centidegrees C (u16)
  heatsinkTemp: integer('heatsink_temp'), // centidegrees C (u16)
  leftWaterTemp: integer('left_water_temp'), // centidegrees C (u16)
  rightWaterTemp: integer('right_water_temp'), // centidegrees C (u16)
}, t => [
  uniqueIndex('idx_freezer_temp_timestamp').on(t.timestamp),
])

export const waterLevelReadings = sqliteTable('water_level_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  level: text('level', { enum: ['low', 'ok'] }).notNull(),
}, t => [
  uniqueIndex('idx_water_level_timestamp').on(t.timestamp),
])

export const waterLevelAlerts = sqliteTable('water_level_alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  type: text('type', { enum: ['low_sustained', 'rapid_change', 'leak_suspected'] }).notNull(),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  dismissedAt: integer('dismissed_at', { mode: 'timestamp' }),
  message: text('message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, t => [
  index('idx_water_level_alerts_dismissed').on(t.dismissedAt),
])

export const ambientLight = sqliteTable('ambient_light', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  lux: real('lux'),
}, t => [
  uniqueIndex('idx_ambient_light_timestamp').on(t.timestamp),
])

export const flowReadings = sqliteTable('flow_readings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  leftFlowrateCd: integer('left_flowrate_cd'), // centidegrees, matching bed_temp convention
  rightFlowrateCd: integer('right_flowrate_cd'),
  leftPumpRpm: integer('left_pump_rpm'),
  rightPumpRpm: integer('right_pump_rpm'),
}, t => [
  uniqueIndex('idx_flow_readings_timestamp').on(t.timestamp),
])

// ── Calibration tables ──

export const calibrationProfiles = sqliteTable('calibration_profiles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  sensorType: text('sensor_type', { enum: ['piezo', 'capacitance', 'temperature'] }).notNull(),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  parameters: text('parameters', { mode: 'json' }).notNull(), // sensor-specific JSON
  qualityScore: real('quality_score'), // 0.0–1.0
  sourceWindowStart: integer('source_window_start'), // unix ts
  sourceWindowEnd: integer('source_window_end'), // unix ts
  samplesUsed: integer('samples_used'),
  errorMessage: text('error_message'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
}, t => [
  index('idx_cal_type_status').on(t.sensorType, t.status),
  uniqueIndex('uq_cal_side_type_active').on(t.side, t.sensorType),
])

export const calibrationRuns = sqliteTable('calibration_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  sensorType: text('sensor_type', { enum: ['piezo', 'capacitance', 'temperature'] }).notNull(),
  status: text('status', { enum: ['completed', 'failed'] }).notNull(),
  parameters: text('parameters', { mode: 'json' }),
  qualityScore: real('quality_score'),
  sourceWindowStart: integer('source_window_start'),
  sourceWindowEnd: integer('source_window_end'),
  samplesUsed: integer('samples_used'),
  errorMessage: text('error_message'),
  durationMs: integer('duration_ms'),
  triggeredBy: text('triggered_by', { enum: ['daily', 'manual', 'startup'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, t => [
  index('idx_cal_runs_side_type').on(t.side, t.sensorType, t.createdAt),
])

export const vitalsQuality = sqliteTable('vitals_quality', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  vitalsId: integer('vitals_id').notNull(), // FK to vitals.id
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  qualityScore: real('quality_score').notNull(), // 0.0–1.0
  flags: text('flags', { mode: 'json' }), // ['low_signal', 'hr_out_of_bounds', ...]
  hrRaw: real('hr_raw'), // pre-validation HR
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, t => [
  index('idx_vq_vitals_id').on(t.vitalsId),
  index('idx_vq_side_ts').on(t.side, t.timestamp),
])
