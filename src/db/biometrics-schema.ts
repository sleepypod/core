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
  uniqueIndex('uq_vitals_side_timestamp').on(t.side, t.timestamp),
  // Retention pruning deletes WHERE timestamp < cutoff; without a plain
  // timestamp index that is a full scan of the pod's largest table.
  index('idx_vitals_timestamp').on(t.timestamp),
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
  // See idx_vitals_timestamp — retention pruning needs a timestamp seek.
  index('idx_movement_timestamp').on(t.timestamp),
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
  raw: integer('raw'),
  calibratedEmpty: integer('calibrated_empty'),
  calibratedFull: integer('calibrated_full'),
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

// Downsampled capacitive presence frames for historical replay. The live
// capSense matrix arrives ~2 Hz and is never persisted raw; this table holds one
// windowed row per side (~5s) so the spatial zone replay and cap.* backtest can
// reach recent nights. Pruned aggressively (~48h) — it is the bulkiest sensor
// stream and only the last night or two is ever replayed.
export const capSenseFrames = sqliteTable('cap_sense_frames', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  // [head, torso, legs] windowed-mean zone loads, or null for a scalar (Pod 3)
  // sensor with no spatial resolution.
  zones: text('zones', { mode: 'json' }),
  max: real('max').notNull(),
  mean: real('mean').notNull(),
  spread: real('spread').notNull(),
  peakZone: integer('peak_zone'), // 0–2 modal zone over the window, or null
  frameCount: integer('frame_count').notNull(), // raw frames aggregated into this row
  // Per-side status histogram `{status: sampleCount}` over the window, e.g.
  // `{"good": 8, "warmup": 2}`. Null when every sample was "good" (or carried
  // no status, as on legacy .RAW frames) — the overwhelmingly common case, so
  // storage cost ≈ nil. Populated only from the NATS capSense dialect, whose
  // per-side records carry `status`. Feeds the future capSense.status gate:
  // lets us correlate historically which windows were non-good before gating
  // on states we have not yet observed in the field.
  statusCounts: text('status_counts', { mode: 'json' }),
}, t => [
  // One row per side/window — guards against duplicates if a restart re-reads
  // the active RAW file from the start (insert is conflict-tolerant).
  uniqueIndex('uq_cap_sense_frames_side_ts').on(t.side, t.timestamp),
  index('idx_cap_sense_frames_timestamp').on(t.timestamp),
])

export const pumpAlerts = sqliteTable('pump_alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  type: text('type', {
    enum: [
      'stall_left',
      'stall_right',
      'no_flow_left',
      'no_flow_right',
      'asymmetry',
      'clog_suspected',
      'hub_temp_disputed',
    ],
  }).notNull(),
  side: text('side', { enum: ['left', 'right'] }),
  rpm: integer('rpm'),
  flowrateCd: integer('flowrate_cd'),
  durationSeconds: integer('duration_seconds'),
  action: text('action', {
    enum: ['power_off', 'auto_recovered', 'warned', 'none'],
  }).notNull().default('none'),
  // Snapshot of side state immediately before the trip so an
  // acknowledgement can restore it through the normal command path.
  restoreTargetTemperature: integer('restore_target_temperature'),
  restoreDurationSeconds: integer('restore_duration_seconds'),
  acknowledgedAt: integer('acknowledged_at', { mode: 'timestamp' }),
  dismissedAt: integer('dismissed_at', { mode: 'timestamp' }),
}, t => [
  index('idx_pump_alerts_timestamp').on(t.timestamp),
  index('idx_pump_alerts_acknowledged').on(t.acknowledgedAt),
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
  triggeredBy: text('triggered_by', { enum: ['daily', 'manual', 'startup', 'retry'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, t => [
  index('idx_cal_runs_side_type').on(t.side, t.sensorType, t.createdAt),
])

export const vitalsQuality = sqliteTable('vitals_quality', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Logical reference to vitals.id — intentionally NOT a real FK: SQLite
  // only enforces FKs with PRAGMA foreign_keys=ON, which none of the
  // writers (Node or Python) enable, and adding one now would need a full
  // table rebuild. Rows are kept in lockstep with vitals by retention.ts
  // pruning both tables on the same timestamp cutoff.
  vitalsId: integer('vitals_id').notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  qualityScore: real('quality_score').notNull(), // 0.0–1.0
  flags: text('flags', { mode: 'json' }), // ['low_signal', 'hr_out_of_bounds', ...]
  hrRaw: real('hr_raw'), // pre-validation HR
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
}, t => [
  index('idx_vq_vitals_id').on(t.vitalsId),
  index('idx_vq_side_ts').on(t.side, t.timestamp),
  // See idx_vitals_timestamp — retention pruning needs a timestamp seek.
  index('idx_vq_timestamp').on(t.timestamp),
])
