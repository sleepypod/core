import { sql } from 'drizzle-orm'
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
  hrv: real('hrv'), // ms — window_ibi_variability_v1, NOT clinical RMSSD
  breathingRate: real('breathing_rate'), // breaths/min
  processingRunId: text('processing_run_id'), // null = legacy_unknown; never infer provenance
}, t => [
  uniqueIndex('uq_vitals_side_timestamp').on(t.side, t.timestamp),
  // Retention pruning deletes WHERE timestamp < cutoff; without a plain
  // timestamp index that is a full scan of the pod's largest table.
  index('idx_vitals_timestamp').on(t.timestamp),
])

// Detected heartbeat times, one row per side per ~60 s chunk, written by the
// piezo-processor's beat detector. Beats are stored rather than intervals so
// discontinuities are explicit: `beats` is a JSON array of millisecond offsets
// from `timestamp`, where `null` marks a break (rejected beat, missed beat or
// signal gap) — no interval may be computed across it. Sleep staging turns
// these into RR intervals for its HRV features, so a better model later can
// re-score past nights without re-reading raw sensor data.
export const heartbeats = sqliteTable('heartbeats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(), // chunk start
  beats: text('beats', { mode: 'json' }).notNull(), // (number | null)[] ms offsets
  quality: real('quality'), // 0–1 mean beat confidence over the chunk
}, t => [
  // Restart replays the current RAW file; the writer ignores conflicts.
  uniqueIndex('uq_heartbeats_side_timestamp').on(t.side, t.timestamp),
  // See idx_vitals_timestamp — retention pruning needs a timestamp seek.
  index('idx_heartbeats_timestamp').on(t.timestamp),
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

/**
 * Per-side regulation state sampled from the DAC status poll: at most once a
 * minute per side, plus immediately on every power transition. It gives the
 * Thermal page target/bed history and power-on markers, which device_state
 * (a single current row per side) can't.
 */
export const thermalState = sqliteTable('thermal_state', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  isPowered: integer('is_powered', { mode: 'boolean' }).notNull(),
  targetTempF: real('target_temp_f'),
  currentTempF: real('current_temp_f'),
}, t => [
  index('idx_thermal_state_timestamp').on(t.timestamp),
])

/** One row per completed prime cycle (priming → not priming on the DAC status). */
export const primeEvents = sqliteTable('prime_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
}, t => [
  index('idx_prime_events_timestamp').on(t.timestamp),
])

/**
 * Run-length history of System → Health's data-path checks. The sampler
 * extends the open run for a check (last_seen_at) every minute while its
 * status holds, and starts a new run when it changes. Time covered by no run
 * is time the core wasn't sampling (not running), shown as a gap.
 */
export const healthRuns = sqliteTable('health_runs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checkId: text('check_id').notNull(),
  status: text('status', { enum: ['ok', 'idle', 'stale', 'down', 'unknown'] }).notNull(),
  detail: text('detail'),
  startedAt: integer('started_at', { mode: 'timestamp' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp' }).notNull(),
}, t => [
  index('idx_health_runs_check_started').on(t.checkId, t.startedAt),
  index('idx_health_runs_last_seen').on(t.lastSeenAt),
])

/**
 * Hourly readings of the eMMC's cumulative sectors-written counter
 * (/sys/block/<dev>/stat) for System → Storage's writes-per-day. The kernel
 * resets the counter at boot, so each row carries the boot it was read in.
 */
export const flashWriteSamples = sqliteTable('flash_write_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  bootId: text('boot_id').notNull(),
  sectorsWritten: integer('sectors_written').notNull(),
}, t => [
  index('idx_flash_write_samples_timestamp').on(t.timestamp),
])

/**
 * Externally scored sleep stages (Apple Watch SleepAnalysis posted by the iOS
 * app) used as a named comparison source for the pod's stage classifier. One
 * row per contiguous segment. A repeated post of the same night is a no-op:
 * the unique key is the segment start per side and source.
 */
export const referenceStages = sqliteTable('reference_stages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  source: text('source', { enum: ['apple_watch'] }).notNull(),
  start: integer('start', { mode: 'timestamp' }).notNull(),
  end: integer('end', { mode: 'timestamp' }).notNull(),
  stage: text('stage', { enum: ['wake', 'light', 'deep', 'rem'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  importId: text('import_id'), // nullable for exports imported before provenance support
}, t => [
  // Start before source so getReferenceStages (side + start range, no source)
  // can seek and read in order instead of scanning the side and sorting.
  uniqueIndex('uq_reference_stages_side_start_source').on(t.side, t.start, t.source),
])

/**
 * Externally measured heart rate (Apple Watch samples posted from a Health
 * export or the iOS app), kept beside the pod's own `vitals` so the two can be
 * compared without one polluting the other: the pod series feeds occupancy,
 * sleep staging and the charts' baselines, so Watch samples must never land in
 * `vitals`. One row per sample; a repeated post is a no-op (unique on side,
 * timestamp, source). Low volume (one sample every few minutes while worn),
 * kept indefinitely like reference_stages.
 */
export const referenceVitals = sqliteTable('reference_vitals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  source: text('source', { enum: ['apple_watch'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  heartRate: real('heart_rate').notNull(), // bpm
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  importId: text('import_id'), // nullable for exports imported before provenance support
}, t => [
  // Timestamp before source so getReferenceVitals (side + time range, no
  // source) seeks and reads in order.
  uniqueIndex('uq_reference_vitals_side_timestamp_source').on(t.side, t.timestamp, t.source),
])

/**
 * Externally measured breathing rate (breaths/min) and HRV SDNN (ms) from an
 * Apple Health export, one row per sample and metric. Kept apart from
 * reference_vitals because the Watch records each metric at its own times, so
 * a shared row keyed on timestamp would make one metric's first write block
 * another's. Same rules as reference_vitals: never mixed into `vitals`, a
 * repeated post is a no-op (unique on side, metric, timestamp, source), low
 * volume, kept indefinitely.
 */
export const referenceSamples = sqliteTable('reference_samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  source: text('source', { enum: ['apple_watch'] }).notNull(),
  metric: text('metric', { enum: ['breathing_rate', 'hrv_sdnn'] }).notNull(),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
  value: real('value').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(() => new Date()),
  importId: text('import_id'), // set in the inserting transaction, like reference_vitals
}, t => [
  uniqueIndex('uq_reference_samples_side_metric_timestamp_source').on(t.side, t.metric, t.timestamp, t.source),
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

// Idempotent projection from the configuration DB. No cross-DB transaction.
export const biometricRuntimeConfigs = sqliteTable('biometric_runtime_configs', {
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  generation: integer('generation').notNull(),
  resolvedHash: text('resolved_hash').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  boundary: text('boundary', { enum: ['immediate', 'next_session'] }).notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
}, t => [uniqueIndex('uq_biometric_runtime_config').on(t.side, t.generation)])

export const biometricRuntimeReceipts = sqliteTable('biometric_runtime_receipts', {
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  component: text('component').notNull(),
  generation: integer('generation').notNull(),
  appliedHash: text('applied_hash').notNull(),
  effectiveSampleTimeMs: integer('effective_sample_time_ms'),
  state: text('state', { enum: ['pending_boundary', 'applied', 'failed'] }).notNull(),
  error: text('error'),
  heartbeatAtMs: integer('heartbeat_at_ms').notNull(),
}, t => [uniqueIndex('uq_biometric_runtime_receipt').on(t.side, t.component, t.generation)])

export const biometricProcessingRuns = sqliteTable('biometric_processing_runs', {
  id: text('id').primaryKey(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  kind: text('kind', { enum: ['live', 'shadow', 'replay'] }).notNull(),
  bundle: text('bundle', { mode: 'json' }).notNull(),
  configHash: text('config_hash').notNull(),
  calibrationHash: text('calibration_hash'), // null explicitly means unavailable
  inputIdentity: text('input_identity', { mode: 'json' }).notNull(),
  startedAtMs: integer('started_at_ms').notNull(),
  endedAtMs: integer('ended_at_ms'),
}, t => [index('idx_biometric_processing_side_start').on(t.side, t.startedAtMs)])

export const referenceImports = sqliteTable('reference_imports', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull(),
  revision: integer('revision').notNull(),
  supersedesImportId: text('supersedes_import_id'),
  contentHash: text('content_hash').notNull(),
  source: text('source').notNull(),
  adapterVersion: text('adapter_version').notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  timePolicy: text('time_policy', { mode: 'json' }).notNull(),
  summary: text('summary', { mode: 'json' }).notNull(),
  overlapPolicy: text('overlap_policy').notNull().default('exclude_conflicts'),
  acceptedCount: integer('accepted_count').notNull(),
  rejectedCount: integer('rejected_count').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  deletedAtMs: integer('deleted_at_ms'),
}, t => [
  uniqueIndex('uq_reference_import_active_root').on(t.contentHash).where(sql`${t.deletedAtMs} IS NULL AND ${t.supersedesImportId} IS NULL`),
  uniqueIndex('uq_reference_import_active_correction').on(t.contentHash, t.supersedesImportId).where(sql`${t.deletedAtMs} IS NULL`),
  uniqueIndex('uq_reference_import_revision').on(t.familyId, t.revision),
  index('idx_reference_import_side_created').on(t.side, t.createdAtMs, t.id),
])

export const referenceMeasurements = sqliteTable('reference_measurements', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  importId: text('import_id').notNull().references(() => referenceImports.id),
  recordKey: text('record_key').notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  metric: text('metric').notNull(),
  value: real('value'),
  stage: text('stage'),
  unit: text('unit').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  temporalKind: text('temporal_kind', { enum: ['point', 'interval'] }).notNull(),
  aggregation: text('aggregation').notNull(),
  windowMs: integer('window_ms'),
  quality: real('quality'),
  scorable: integer('scorable', { mode: 'boolean' }).notNull(),
  exclusions: text('exclusions', { mode: 'json' }).notNull(),
  original: text('original', { mode: 'json' }).notNull(),
}, t => [
  uniqueIndex('uq_reference_measurement_key').on(t.importId, t.recordKey),
  index('idx_reference_measurement_side_metric_start').on(t.side, t.metric, t.startMs),
  index('idx_reference_measurement_import_id').on(t.importId, t.id),
])

// Small processed-data snapshots are retained here; raw waveforms use bounded
// artifacts. The immutable snapshot owns its bytes, independent of retention
// or reference deletion. A content hash alone is not a reproducible dataset.
export const biometricDatasets = sqliteTable('biometric_datasets', {
  id: text('id').primaryKey(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  subjectId: text('subject_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  contentHash: text('content_hash').notNull(),
  manifest: text('manifest', { mode: 'json' }).notNull(),
  snapshot: text('snapshot', { mode: 'json' }).notNull(),
  byteLength: integer('byte_length').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  releasedAtMs: integer('released_at_ms'),
}, t => [index('idx_biometric_dataset_side_created').on(t.side, t.createdAtMs, t.id)])

export const biometricExperiments = sqliteTable('biometric_experiments', {
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').unique(), // null on pre-idempotency experiments
  requestHash: text('request_hash'),
  datasetId: text('dataset_id').notNull().references(() => biometricDatasets.id),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  protocol: text('protocol', { mode: 'json' }).notNull(),
  protocolHash: text('protocol_hash').notNull(),
  holdoutAccesses: integer('holdout_accesses').notNull().default(0),
  createdAtMs: integer('created_at_ms').notNull(),
}, t => [index('idx_biometric_experiment_dataset').on(t.datasetId)])

export const biometricBacktestJobs = sqliteTable('biometric_backtest_jobs', {
  id: text('id').primaryKey(),
  experimentId: text('experiment_id').notNull().references(() => biometricExperiments.id),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  requestHash: text('request_hash').notNull(),
  input: text('input', { mode: 'json' }).notNull(),
  state: text('state', { enum: ['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'failed', 'interrupted'] }).notNull(),
  leaseOwner: text('lease_owner'),
  leaseExpiresAtMs: integer('lease_expires_at_ms'),
  fencingToken: integer('fencing_token').notNull().default(0),
  attempt: integer('attempt').notNull().default(0),
  heartbeatAtMs: integer('heartbeat_at_ms'),
  progress: text('progress', { mode: 'json' }).notNull(),
  cancellationRequestedAtMs: integer('cancellation_requested_at_ms'),
  error: text('error'),
  createdAtMs: integer('created_at_ms').notNull(),
  updatedAtMs: integer('updated_at_ms').notNull(),
}, t => [index('idx_biometric_job_state_created').on(t.state, t.createdAtMs), index('idx_biometric_job_experiment').on(t.experimentId)])

export const biometricBacktestResults = sqliteTable('biometric_backtest_results', {
  jobId: text('job_id').primaryKey().references(() => biometricBacktestJobs.id),
  fencingToken: integer('fencing_token').notNull(),
  report: text('report', { mode: 'json' }).notNull(),
  contentHash: text('content_hash').notNull(),
  completedAtMs: integer('completed_at_ms').notNull(),
  releasedAtMs: integer('released_at_ms'),
})

// Exposure follows physical side and recorded time, not a recreatable dataset
// identifier. Re-freezing the same nights cannot manufacture a fresh holdout.
export const biometricHoldoutAccesses = sqliteTable('biometric_holdout_accesses', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull().references(() => biometricBacktestJobs.id),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  accessedAtMs: integer('accessed_at_ms').notNull(),
}, t => [index('idx_biometric_holdout_side_start').on(t.side, t.startMs)])

// Inspection records are evidence about archive bytes at scan time, not retained
// input availability. A changed source creates a different inspected identity.
export const biometricRawSources = sqliteTable('biometric_raw_sources', {
  id: text('id').primaryKey(),
  sourceName: text('source_name').notNull(),
  artifactHash: text('artifact_hash').notNull(),
  descriptor: text('descriptor', { mode: 'json' }).notNull(),
  inventoryVersion: text('inventory_version').notNull(),
  inventory: text('inventory', { mode: 'json' }).notNull(),
  firstEventMs: integer('first_event_ms'),
  lastEventMs: integer('last_event_ms'),
  inspectedAtMs: integer('inspected_at_ms').notNull(),
  unavailableAtMs: integer('unavailable_at_ms'),
}, t => [
  uniqueIndex('idx_biometric_raw_source_identity').on(t.sourceName, t.artifactHash, t.inventoryVersion),
  index('idx_biometric_raw_source_window').on(t.firstEventMs, t.lastEventMs),
])

// Content-addressed bytes may be shared by multiple immutable datasets. A
// tombstone preserves identity after release; file existence is checked by I/O.
export const biometricRawArtifacts = sqliteTable('biometric_raw_artifacts', {
  contentHash: text('content_hash').primaryKey(),
  name: text('name').notNull().unique(),
  compressedBytes: integer('compressed_bytes').notNull(),
  expandedBytes: integer('expanded_bytes').notNull(),
  createdAtMs: integer('created_at_ms').notNull(),
  releasedAtMs: integer('released_at_ms'),
})

export const biometricDatasetRawArtifacts = sqliteTable('biometric_dataset_raw_artifacts', {
  id: text('id').primaryKey(),
  datasetId: text('dataset_id').notNull().references(() => biometricDatasets.id),
  artifactHash: text('artifact_hash').notNull().references(() => biometricRawArtifacts.contentHash),
  position: integer('position').notNull(),
  releasedAtMs: integer('released_at_ms'),
}, t => [
  uniqueIndex('idx_biometric_dataset_raw_identity').on(t.datasetId, t.artifactHash),
  uniqueIndex('idx_biometric_dataset_raw_position').on(t.datasetId, t.position),
  index('idx_biometric_raw_artifact_references').on(t.artifactHash, t.releasedAtMs),
])

// Prospective candidate output is deliberately separate from canonical vitals.
// Plans are immutable; attempt leases fence restarted shadow workers.
export const biometricShadowRuns = sqliteTable('biometric_shadow_runs', {
  workerReceipt: text('worker_receipt', { mode: 'json' }),
  workerReceiptHash: text('worker_receipt_hash'),
  id: text('id').primaryKey(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  planHash: text('plan_hash').notNull(),
  plan: text('plan', { mode: 'json' }).notNull(),
  side: text('side', { enum: ['left', 'right'] }).notNull(),
  state: text('state', { enum: ['pending', 'running', 'completed', 'stopped', 'failed'] }).notNull(),
  attemptId: text('attempt_id'),
  leaseUntilMs: integer('lease_until_ms'),
  heartbeatAtMs: integer('heartbeat_at_ms'),
  createdAtMs: integer('created_at_ms').notNull(),
  endedAtMs: integer('ended_at_ms'),
  reason: text('reason'),
  pointCount: integer('point_count').notNull().default(0),
  byteCount: integer('byte_count').notNull().default(0),
}, t => [index('idx_biometric_shadow_side_state').on(t.side, t.state)])

export const biometricShadowSamples = sqliteTable('biometric_shadow_samples', {
  runId: text('run_id').notNull().references(() => biometricShadowRuns.id),
  sequence: integer('sequence').notNull(),
  timestampMs: integer('timestamp_ms').notNull(),
  contentHash: text('content_hash').notNull(),
  payload: text('payload', { mode: 'json' }).notNull(),
  byteLength: integer('byte_length').notNull(),
}, t => [uniqueIndex('uq_biometric_shadow_sample').on(t.runId, t.sequence),
  index('idx_biometric_shadow_sample_time').on(t.runId, t.timestampMs)])
