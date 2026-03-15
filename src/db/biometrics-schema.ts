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
