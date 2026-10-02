import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, HOUR, hashSeed, randomBetween, seededRandom } from '../util'

type Overview = RouterOutputs['databases']['overview']
type IntegrityRun = NonNullable<Overview['databases'][number]['integrity']['scheduled']>
type DbKey = 'sleepypod' | 'biometrics'

interface TableSpec {
  name: string
  columns: string[]
  /** Rows written per hour while active. */
  perHour: number
  /** Only written while someone is in bed. */
  nightly?: boolean
  /** Total rows already on disk. */
  rows: number
  bytesPerRow: number
  retention?: { days: number, by: string }
}

const RETAINED = { days: 90, by: 'daily retention pass' }

const TABLES: Record<DbKey, TableSpec[]> = {
  sleepypod: [
    { name: 'device_settings', columns: ['id', 'timezone', 'temperature_unit', 'reboot_daily', 'reboot_time', 'prime_pod_daily', 'prime_pod_time', 'mqtt_enabled', 'mqtt_url', 'mqtt_password', 'homekit_enabled', 'created_at', 'updated_at'], perHour: 0, rows: 1, bytesPerRow: 4096 },
    { name: 'side_settings', columns: ['side', 'name', 'away_mode', 'auto_off_enabled', 'auto_off_minutes', 'always_on', 'created_at', 'updated_at'], perHour: 0, rows: 2, bytesPerRow: 2048 },
    { name: 'device_state', columns: ['side', 'current_temperature', 'target_temperature', 'is_powered', 'is_alarm_vibrating', 'water_level', 'powered_on_at', 'last_updated'], perHour: 0, rows: 2, bytesPerRow: 2048 },
    { name: 'temperature_schedules', columns: ['id', 'side', 'day_of_week', 'time', 'temperature', 'enabled', 'created_at', 'updated_at'], perHour: 0, rows: 56, bytesPerRow: 96 },
    { name: 'power_schedules', columns: ['id', 'side', 'day_of_week', 'on_time', 'off_time', 'on_temperature', 'enabled', 'created_at', 'updated_at'], perHour: 0, rows: 14, bytesPerRow: 96 },
    { name: 'alarm_schedules', columns: ['id', 'side', 'day_of_week', 'time', 'vibration_intensity', 'vibration_pattern', 'duration', 'alarm_temperature', 'enabled', 'created_at', 'updated_at'], perHour: 0, rows: 10, bytesPerRow: 112 },
    { name: 'tap_gestures', columns: ['id', 'side', 'tap_type', 'action_type', 'temperature_change', 'temperature_amount', 'created_at', 'updated_at'], perHour: 0, rows: 4, bytesPerRow: 96 },
    { name: 'temperature_holds', columns: ['side', 'temperature', 'started_at', 'expires_at'], perHour: 0, rows: 0, bytesPerRow: 64 },
    { name: 'system_health', columns: ['id', 'component', 'status', 'message', 'last_checked'], perHour: 12, rows: 9, bytesPerRow: 160 },
    { name: 'run_once_sessions', columns: ['id', 'side', 'set_points', 'wake_time', 'started_at', 'expires_at', 'status', 'created_at'], perHour: 0, rows: 6, bytesPerRow: 256 },
    { name: 'automations', columns: ['id', 'name', 'enabled', 'side', 'priority', 'dry_run', 'cooldown_min', 'trigger', 'conditions', 'actions', 'created_at', 'updated_at'], perHour: 0, rows: 5, bytesPerRow: 512 },
    { name: 'automation_runs', columns: ['id', 'automation_id', 'fired_at', 'outcome', 'detail'], perHour: 3, rows: 2140, bytesPerRow: 140, retention: { days: 90, by: 'automation runs retention pass' } },
  ],
  biometrics: [
    { name: 'vitals', columns: ['id', 'side', 'timestamp', 'heart_rate', 'hrv', 'breathing_rate'], perHour: 24, nightly: true, rows: 41_820, bytesPerRow: 44, retention: RETAINED },
    { name: 'vitals_quality', columns: ['id', 'vitals_id', 'side', 'timestamp', 'quality_score', 'flags', 'hr_raw', 'created_at'], perHour: 24, nightly: true, rows: 41_790, bytesPerRow: 72, retention: RETAINED },
    { name: 'sleep_records', columns: ['id', 'side', 'entered_bed_at', 'left_bed_at', 'sleep_duration_seconds', 'times_exited_bed', 'present_intervals', 'not_present_intervals', 'created_at'], perHour: 0, rows: 176, bytesPerRow: 420 },
    { name: 'movement', columns: ['id', 'side', 'timestamp', 'total_movement'], perHour: 24, nightly: true, rows: 41_800, bytesPerRow: 32, retention: RETAINED },
    { name: 'bed_temp', columns: ['id', 'timestamp', 'ambient_temp', 'mcu_temp', 'humidity', 'left_outer_temp', 'left_center_temp', 'left_inner_temp', 'right_outer_temp', 'right_center_temp', 'right_inner_temp'], perHour: 60, rows: 129_600, bytesPerRow: 64, retention: RETAINED },
    { name: 'freezer_temp', columns: ['id', 'timestamp', 'ambient_temp', 'heatsink_temp', 'left_water_temp', 'right_water_temp'], perHour: 60, rows: 129_600, bytesPerRow: 44, retention: RETAINED },
    { name: 'flow_readings', columns: ['id', 'timestamp', 'left_flowrate_cd', 'right_flowrate_cd', 'left_pump_rpm', 'right_pump_rpm'], perHour: 30, rows: 64_800, bytesPerRow: 44, retention: RETAINED },
    { name: 'ambient_light', columns: ['id', 'timestamp', 'lux'], perHour: 60, rows: 129_600, bytesPerRow: 24, retention: RETAINED },
    { name: 'water_level_readings', columns: ['id', 'timestamp', 'level'], perHour: 12, rows: 25_920, bytesPerRow: 24, retention: RETAINED },
    { name: 'water_level_alerts', columns: ['id', 'type', 'started_at', 'dismissed_at', 'message', 'created_at'], perHour: 0, rows: 1, bytesPerRow: 160 },
    { name: 'pump_alerts', columns: ['id', 'timestamp', 'type', 'side', 'rpm', 'flowrate_cd', 'duration_seconds', 'action', 'restore_target_temperature', 'restore_duration_seconds', 'acknowledged_at', 'dismissed_at'], perHour: 0, rows: 1, bytesPerRow: 96, retention: RETAINED },
    { name: 'thermal_state', columns: ['id', 'timestamp', 'side', 'is_powered', 'target_temp_f', 'current_temp_f'], perHour: 120, rows: 259_200, bytesPerRow: 40, retention: RETAINED },
    { name: 'cap_sense_frames', columns: ['id', 'side', 'timestamp', 'zones', 'max', 'mean', 'spread', 'peak_zone', 'frame_count', 'status_counts'], perHour: 120, rows: 5_760, bytesPerRow: 180, retention: { days: 2, by: 'cap frame writer' } },
    { name: 'prime_events', columns: ['id', 'timestamp'], perHour: 0, rows: 31, bytesPerRow: 16 },
    { name: 'health_runs', columns: ['id', 'check_id', 'status', 'detail', 'started_at', 'last_seen_at'], perHour: 4, rows: 2_150, bytesPerRow: 120, retention: RETAINED },
    { name: 'calibration_profiles', columns: ['id', 'side', 'sensor_type', 'status', 'parameters', 'quality_score', 'samples_used', 'error_message', 'created_at', 'expires_at'], perHour: 0, rows: 6, bytesPerRow: 640 },
    { name: 'calibration_runs', columns: ['id', 'side', 'sensor_type', 'status', 'parameters', 'quality_score', 'samples_used', 'duration_ms', 'triggered_by', 'created_at'], perHour: 0, rows: 540, bytesPerRow: 640 },
  ],
}

const MIGRATIONS: Record<DbKey, { count: number, tag: string }> = {
  sleepypod: { count: 17, tag: '0016_hardware_deadline' },
  biometrics: { count: 17, tag: '0016_health_runs' },
}

const isNight = (t: number) => {
  const h = new Date(t).getHours()
  return h >= 23 || h < 7
}

const integrityRun = (checkedAt: number, latencyMs: number): IntegrityRun => ({ status: 'ok', checkedAt: new Date(checkedAt).toISOString(), latencyMs })

let manual: Partial<Record<DbKey, IntegrityRun>> = {}

function overview(): Overview {
  const now = Date.now()
  const hoursFrom = Math.floor(now / HOUR) * HOUR - 23 * HOUR
  const occupiedHours = Array.from({ length: 24 }, (_, h) => h).filter(h => isNight(hoursFrom + h * HOUR))

  const databases = (['sleepypod', 'biometrics'] as const).map((key) => {
    const tables = TABLES[key].map((t) => {
      const hourly = Array.from({ length: 24 }, (_, h) => {
        if (t.perHour === 0 || (t.nightly && !isNight(hoursFrom + h * HOUR))) return 0
        const rand = seededRandom(hashSeed(`${t.name}:${hoursFrom + h * HOUR}`))
        return Math.max(0, Math.round(t.perHour * randomBetween(rand, 0.9, 1.1)))
      })
      const rows24h = hourly.reduce((a, b) => a + b, 0)
      const lastBucket = [...hourly].reverse().findIndex(n => n > 0)
      const timeColumn = t.columns.find(c => ['timestamp', 'fired_at', 'last_seen_at', 'last_checked', 'last_updated', 'updated_at', 'created_at', 'started_at'].includes(c)) ?? null
      return {
        name: t.name,
        rows: t.rows,
        bytes: t.rows * t.bytesPerRow + 4096,
        timeColumn,
        timeInMs: false,
        lastWriteAt: timeColumn && t.rows > 0
          ? Math.floor((lastBucket >= 0 ? now - lastBucket * HOUR - 40_000 : now - 3 * DAY) / 1000)
          : null,
        oldestAt: timeColumn && t.rows > 0 ? Math.floor((now - (t.retention?.days ?? 64) * DAY) / 1000) : null,
        hourly,
        rows24h,
        retention: t.retention ?? null,
      }
    })
    const fileBytes = tables.reduce((s, t) => s + t.bytes, 0)
    return {
      key,
      path: `/persistent/sleepypod-data/${key}.db`,
      fileBytes,
      walBytes: key === 'biometrics' ? 2_871_232 : 412_000,
      pageSize: 4096,
      freePages: key === 'biometrics' ? 214 : 12,
      walAutocheckpoint: 1000,
      integrity: {
        scheduled: integrityRun(Math.floor(now / HOUR) * HOUR + 7 * 60_000 - (now % HOUR < 7 * 60_000 ? HOUR : 0), key === 'biometrics' ? 412 : 38),
        manual: manual[key] ?? null,
      },
      migrations: { applied: MIGRATIONS[key].count, known: MIGRATIONS[key].count, latestTag: MIGRATIONS[key].tag, appliedTag: MIGRATIONS[key].tag },
      tables,
    }
  })

  return {
    at: now,
    hoursFrom,
    dataDir: '/persistent/sleepypod-data',
    disk: { totalBytes: 7_516_192_768, availableBytes: 2_480_000_000 },
    lastBackupAt: now - 2 * DAY - 5 * HOUR,
    occupiedHours,
    databases,
  }
}

/** Plausible cell value for a column, from its name alone. */
function cellFor(column: string, rowIndex: number, idTop: number, rand: () => number): string | number | null {
  const now = Math.floor(Date.now() / 1000)
  if (column === 'id' || column === 'vitals_id') return idTop - rowIndex
  if (/password|secret|token|api_?key/i.test(column)) return '••••'
  if (column === 'side') return rowIndex % 2 === 0 ? 'left' : 'right'
  if (/(_at|timestamp|last_checked|last_updated)$/.test(column)) return now - rowIndex * 60 - Math.floor(rand() * 20)
  if (column === 'level') return 'ok'
  if (column === 'status') return 'ok'
  if (column === 'heart_rate') return Math.round(randomBetween(rand, 52, 66))
  if (column === 'hrv') return Math.round(randomBetween(rand, 38, 72))
  if (column === 'breathing_rate') return Math.round(randomBetween(rand, 12, 16) * 10) / 10
  if (/temp/.test(column)) return Math.round(randomBetween(rand, 2400, 2900))
  if (/rpm/.test(column)) return Math.round(randomBetween(rand, 2340, 2460))
  if (/flowrate/.test(column)) return Math.round(randomBetween(rand, 2810, 2930))
  if (column === 'humidity') return Math.round(randomBetween(rand, 4200, 4600))
  if (column === 'lux') return Math.round(randomBetween(rand, 0, 4) * 10) / 10
  if (/enabled|is_|away_mode|always_on|dry_run/.test(column)) return rand() > 0.3 ? 1 : 0
  if (/movement|quality|score|mean|max|spread/.test(column)) return Math.round(rand() * 1000) / 1000
  return Math.round(rand() * 100)
}

export const databases: DemoHandlers<'databases'> = {
  overview: () => overview(),

  checkIntegrity: () => {
    const now = Date.now()
    manual = { sleepypod: integrityRun(now, 41), biometrics: integrityRun(now, 398) }
    return manual
  },

  rows: (input) => {
    const spec = TABLES[input.db].find(t => t.name === input.table)
    if (!spec) throw new Error(`No table ${input.table} in ${input.db}.db`)
    if (input.column != null && !spec.columns.includes(input.column)) throw new Error(`No column ${input.column} in ${input.table}`)
    const filtered = input.column != null && input.value != null
    const total = filtered ? Math.min(spec.rows, 12) : spec.rows
    const offset = input.offset ?? 0
    const limit = input.limit ?? 8
    const rows = Array.from({ length: Math.max(0, Math.min(limit, total - offset)) }, (_, i) => {
      const index = offset + i
      const rand = seededRandom(hashSeed(`${input.table}:${index}`))
      return spec.columns.map(c => (filtered && c === input.column ? input.value as string : cellFor(c, index, spec.rows, rand)))
    })
    return {
      columns: spec.columns,
      timeColumn: spec.columns.find(c => ['timestamp', 'fired_at', 'last_seen_at', 'last_checked', 'last_updated', 'updated_at', 'created_at', 'started_at'].includes(c)) ?? null,
      rows,
      total,
    }
  },
}
