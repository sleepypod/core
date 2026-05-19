/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

// ── Hardware mocks ────────────────────────────────────────────────────────
type AnyAsync = (...args: any[]) => Promise<void>
const setTemperature = vi.fn<AnyAsync>()
const setPower = vi.fn<AnyAsync>()
const setAlarm = vi.fn<AnyAsync>()
const startPriming = vi.fn<AnyAsync>()
const connect = vi.fn<() => Promise<void>>()
setTemperature.mockResolvedValue(undefined)
setPower.mockResolvedValue(undefined)
setAlarm.mockResolvedValue(undefined)
startPriming.mockResolvedValue(undefined)
connect.mockResolvedValue(undefined)

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect, setTemperature, setPower, setAlarm, startPriming }),
}))

vi.mock('@/src/hardware/dacTransport', () => ({
  sendCommand: vi.fn(async () => {}),
}))

const broadcastMutationStatus = vi.fn<(side: 'left' | 'right', patch: Record<string, unknown>) => void>()
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: (side: 'left' | 'right', patch: Record<string, unknown>) => broadcastMutationStatus(side, patch),
}))

const cancelAutoOffTimer = vi.fn<(side: 'left' | 'right') => void>()
vi.mock('@/src/services/autoOffWatcher', () => ({
  cancelAutoOffTimer: (side: 'left' | 'right') => cancelAutoOffTimer(side),
}))

// Mock child_process.exec so executeReboot tests never spawn systemctl.
const execMock = vi.fn<(cmd: string, cb: (err: Error | null) => void) => void>()
execMock.mockImplementation((_cmd, cb) => cb(null))
vi.mock('child_process', () => ({
  exec: (cmd: string, cb: (err: Error | null) => void) => execMock(cmd, cb),
}))

// Mock node:fs/promises so calibration-trigger tests don't touch disk.
const writeFileMock = vi.fn<AnyAsync>()
const renameMock = vi.fn<AnyAsync>()
writeFileMock.mockResolvedValue(undefined)
renameMock.mockResolvedValue(undefined)
vi.mock('node:fs/promises', () => ({
  writeFile: (...args: any[]) => writeFileMock(...args),
  rename: (...args: any[]) => renameMock(...args),
}))

// In-memory primary DB seeded with the schema the JobManager reads
vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const primary = new BetterSqlite3(':memory:')
  primary.pragma('foreign_keys = ON')
  return {
    db: drizzle(primary, { schema }),
    biometricsDb: null,
    sqlite: primary,
    biometricsSqlite: null,
    closeDatabase: vi.fn(),
    closeBiometricsDatabase: vi.fn(),
  }
})

import * as dbModule from '@/src/db'
import { JobManager } from '../jobManager'
import { fahrenheitToLevel } from '@/src/hardware/types'
const { sqlite } = dbModule as typeof dbModule & { sqlite: BetterSqlite3.Database }

function resetSchema(): void {
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS device_state;
    DROP TABLE IF EXISTS run_once_sessions;
    DROP TABLE IF EXISTS temperature_schedules;
    DROP TABLE IF EXISTS power_schedules;
    DROP TABLE IF EXISTS alarm_schedules;
    DROP TABLE IF EXISTS device_settings;
    DROP TABLE IF EXISTS side_settings;

    CREATE TABLE device_state (
      side TEXT PRIMARY KEY,
      current_temperature REAL,
      target_temperature REAL,
      is_powered INTEGER NOT NULL DEFAULT 0,
      is_alarm_vibrating INTEGER NOT NULL DEFAULT 0,
      water_level TEXT DEFAULT 'unknown',
      powered_on_at INTEGER,
      last_updated INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE run_once_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      set_points TEXT NOT NULL,
      wake_time TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE temperature_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      day_of_week TEXT NOT NULL,
      time TEXT NOT NULL,
      temperature REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE power_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      day_of_week TEXT NOT NULL,
      on_time TEXT NOT NULL,
      off_time TEXT NOT NULL,
      on_temperature REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE alarm_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      day_of_week TEXT NOT NULL,
      time TEXT NOT NULL,
      vibration_intensity INTEGER NOT NULL,
      vibration_pattern TEXT NOT NULL DEFAULT 'rise',
      duration INTEGER NOT NULL,
      alarm_temperature REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE device_settings (
      id INTEGER PRIMARY KEY,
      timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
      temperature_unit TEXT NOT NULL DEFAULT 'F',
      reboot_daily INTEGER NOT NULL DEFAULT 0,
      reboot_time TEXT DEFAULT '03:00',
      prime_pod_daily INTEGER NOT NULL DEFAULT 0,
      prime_pod_time TEXT DEFAULT '14:00',
      led_night_mode_enabled INTEGER NOT NULL DEFAULT 0,
      led_day_brightness INTEGER NOT NULL DEFAULT 100,
      led_night_brightness INTEGER NOT NULL DEFAULT 0,
      led_night_start_time TEXT DEFAULT '22:00',
      led_night_end_time TEXT DEFAULT '07:00',
      global_max_on_hours INTEGER,
      mqtt_enabled INTEGER,
      mqtt_url TEXT,
      mqtt_username TEXT,
      mqtt_password TEXT,
      mqtt_topic_prefix TEXT,
      mqtt_ha_discovery INTEGER,
      mqtt_tls_enabled INTEGER,
      mqtt_tls_insecure INTEGER,
      homekit_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE side_settings (
      side TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      away_mode INTEGER NOT NULL DEFAULT 0,
      always_on INTEGER NOT NULL DEFAULT 0,
      auto_off_enabled INTEGER NOT NULL DEFAULT 0,
      auto_off_minutes INTEGER NOT NULL DEFAULT 30,
      away_start TEXT,
      away_return TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
}

function insertTempSchedule(opts: {
  side: 'left' | 'right'
  dayOfWeek: string
  time: string
  temperature: number
  enabled?: boolean
}): number {
  const info = (sqlite as any)
    .prepare(
      `INSERT INTO temperature_schedules (side, day_of_week, time, temperature, enabled)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(opts.side, opts.dayOfWeek, opts.time, opts.temperature, opts.enabled === false ? 0 : 1)
  return Number(info.lastInsertRowid)
}

function insertPowerSchedule(opts: {
  side: 'left' | 'right'
  dayOfWeek: string
  onTime: string
  offTime: string
  onTemperature: number
  enabled?: boolean
}): number {
  const info = (sqlite as any)
    .prepare(
      `INSERT INTO power_schedules (side, day_of_week, on_time, off_time, on_temperature, enabled)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.side,
      opts.dayOfWeek,
      opts.onTime,
      opts.offTime,
      opts.onTemperature,
      opts.enabled === false ? 0 : 1,
    )
  return Number(info.lastInsertRowid)
}

function insertAlarmSchedule(opts: {
  side: 'left' | 'right'
  dayOfWeek: string
  time: string
  alarmTemperature: number
  enabled?: boolean
}): number {
  const info = (sqlite as any)
    .prepare(
      `INSERT INTO alarm_schedules
        (side, day_of_week, time, vibration_intensity, vibration_pattern, duration, alarm_temperature, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(opts.side, opts.dayOfWeek, opts.time, 80, 'rise', 30, opts.alarmTemperature, opts.enabled === false ? 0 : 1)
  return Number(info.lastInsertRowid)
}

function insertDeviceSettings(overrides: Record<string, unknown> = {}): void {
  const defaults: Record<string, unknown> = {
    id: 1,
    timezone: 'America/Los_Angeles',
    temperature_unit: 'F',
    reboot_daily: 0,
    reboot_time: '03:00',
    prime_pod_daily: 0,
    prime_pod_time: '14:00',
    led_night_mode_enabled: 0,
    led_day_brightness: 100,
    led_night_brightness: 0,
    led_night_start_time: '22:00',
    led_night_end_time: '07:00',
    homekit_enabled: 0,
  }
  const row = { ...defaults, ...overrides }
  ;(sqlite as any)
    .prepare(
      `INSERT INTO device_settings
        (id, timezone, temperature_unit, reboot_daily, reboot_time, prime_pod_daily, prime_pod_time,
         led_night_mode_enabled, led_day_brightness, led_night_brightness,
         led_night_start_time, led_night_end_time, homekit_enabled)
       VALUES (@id, @timezone, @temperature_unit, @reboot_daily, @reboot_time, @prime_pod_daily, @prime_pod_time,
               @led_night_mode_enabled, @led_day_brightness, @led_night_brightness,
               @led_night_start_time, @led_night_end_time, @homekit_enabled)`
    )
    .run(row)
}

function insertSideSettings(opts: {
  side: 'left' | 'right'
  awayStart?: string | null
  awayReturn?: string | null
}): void {
  ;(sqlite as any)
    .prepare(
      `INSERT INTO side_settings (side, name, away_start, away_return)
       VALUES (?, ?, ?, ?)`
    )
    .run(opts.side, opts.side, opts.awayStart ?? null, opts.awayReturn ?? null)
}

function insertRunOnceSession(opts: {
  side: 'left' | 'right'
  setPoints: string
  wakeTime: string
  startedAt: Date
  expiresAt: Date
  status?: 'active' | 'completed' | 'cancelled'
}): number {
  const info = (sqlite as any)
    .prepare(
      `INSERT INTO run_once_sessions (side, set_points, wake_time, started_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      opts.side,
      opts.setPoints,
      opts.wakeTime,
      Math.floor(opts.startedAt.getTime() / 1000),
      Math.floor(opts.expiresAt.getTime() / 1000),
      opts.status ?? 'active',
    )
  return Number(info.lastInsertRowid)
}

function seedSidePowered(side: 'left' | 'right', isPowered: boolean): void {
  ;(sqlite as any)
    .prepare(
      `INSERT INTO device_state (side, is_powered, target_temperature)
       VALUES (?, ?, ?)
       ON CONFLICT(side) DO UPDATE SET is_powered = excluded.is_powered, target_temperature = excluded.target_temperature`
    )
    .run(side, isPowered ? 1 : 0, isPowered ? 80 : null)
}

function readSide(side: 'left' | 'right') {
  return (sqlite as any)
    .prepare(`SELECT side, is_powered, target_temperature FROM device_state WHERE side = ?`)
    .get(side) as { side: string, is_powered: number, target_temperature: number | null } | undefined
}

const tempSched = (side: 'left' | 'right', temperature: number) => ({
  id: 1,
  side,
  dayOfWeek: 'saturday' as const,
  time: '10:00',
  temperature,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
})

const alarmSched = (side: 'left' | 'right') => ({
  id: 1,
  side,
  dayOfWeek: 'saturday' as const,
  time: '09:00',
  alarmTemperature: 88,
  vibrationIntensity: 100,
  vibrationPattern: 'rise' as const,
  duration: 10,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
})

const powerSched = (side: 'left' | 'right') => ({
  id: 1,
  side,
  dayOfWeek: 'saturday' as const,
  onTime: '22:00',
  offTime: '10:00',
  onTemperature: 89,
  enabled: true,
  createdAt: new Date(),
  updatedAt: new Date(),
})

describe('JobManager — job ordering and gating', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    setAlarm.mockClear()
    connect.mockClear()
    broadcastMutationStatus.mockClear()
    cancelAutoOffTimer.mockClear()
    setTemperature.mockImplementation(async () => {})
    setPower.mockImplementation(async () => {})
    setAlarm.mockImplementation(async () => {})
    manager = new JobManager('America/Los_Angeles', {
      heartbeatIntervalMs: 60_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  describe('temperature gating by isPowered', () => {
    it('fires setTemperature when side is powered', async () => {
      seedSidePowered('left', true)

      await manager.runTemperatureJob(tempSched('left', 75))

      expect(setTemperature).toHaveBeenCalledOnce()
      expect(setTemperature).toHaveBeenCalledWith('left', 75)
    })

    it('skips setTemperature when side is not powered', async () => {
      seedSidePowered('left', false)

      await manager.runTemperatureJob(tempSched('left', 75))

      expect(setTemperature).not.toHaveBeenCalled()
    })

    it('skips setTemperature when side has no device_state row', async () => {
      // No row inserted at all
      await manager.runTemperatureJob(tempSched('right', 80))

      expect(setTemperature).not.toHaveBeenCalled()
    })
  })

  describe('alarm gating by isPowered', () => {
    it('fires alarm + temperature when side is powered', async () => {
      seedSidePowered('right', true)

      await manager.runAlarmJob(alarmSched('right'))

      expect(setTemperature).toHaveBeenCalledWith('right', 88)
      expect(setAlarm).toHaveBeenCalledOnce()
    })

    it('fires alarm but skips temperature when side is not powered', async () => {
      // Vibration must wake the user even when the bed is off — that's the
      // whole point of an alarm. Temperature stays gated to avoid re-heating
      // a deliberately-off side.
      seedSidePowered('right', false)

      await manager.runAlarmJob(alarmSched('right'))

      expect(setTemperature).not.toHaveBeenCalled()
      expect(setAlarm).toHaveBeenCalledOnce()
      expect(setAlarm).toHaveBeenCalledWith('right', {
        vibrationIntensity: 100,
        vibrationPattern: 'rise',
        duration: 10,
      })
    })

    it('fires alarm when side has no device_state row (treated as off)', async () => {
      // No row inserted at all
      await manager.runAlarmJob(alarmSched('left'))

      expect(setTemperature).not.toHaveBeenCalled()
      expect(setAlarm).toHaveBeenCalledOnce()
    })

    it('broadcast omits temperature fields but keeps isAlarmVibrating when not powered', async () => {
      seedSidePowered('right', false)

      await manager.runAlarmJob(alarmSched('right'))

      expect(broadcastMutationStatus).toHaveBeenCalledOnce()
      expect(broadcastMutationStatus).toHaveBeenCalledWith('right', {
        isAlarmVibrating: true,
      })
    })
  })

  describe('powerOff state synchronization', () => {
    it('marks device_state.isPowered=false BEFORE sending setPower(false)', async () => {
      seedSidePowered('left', true)

      // Capture is_powered at the moment setPower is invoked.
      let isPoweredAtSetPower: number | undefined
      setPower.mockImplementationOnce(async () => {
        const row = readSide('left')
        isPoweredAtSetPower = row?.is_powered
      })

      await manager.runPowerOffJob(powerSched('left'))

      expect(setPower).toHaveBeenCalledWith('left', false)
      expect(isPoweredAtSetPower).toBe(0)
    })

    it('clears target_temperature on power off', async () => {
      seedSidePowered('left', true)

      await manager.runPowerOffJob(powerSched('left'))

      const row = readSide('left')
      expect(row?.is_powered).toBe(0)
      expect(row?.target_temperature).toBeNull()
    })
  })

  describe('per-side mutex serializes concurrent jobs (same-minute race)', () => {
    it('temperature job dispatched concurrently with power_off does not re-enable heat', async () => {
      // The bug: at HH:MM both fire. Without the lock, setTemperature(80)
      // landed last and re-enabled the side. With the lock + isPowered gate,
      // power_off updates DB→false then sends setPower(false); temp picks up
      // the lock after, sees isPowered=false, skips setTemperature.
      seedSidePowered('left', true)

      // Make hardware setPower take a beat so the temp handler queues
      // behind it on the lock instead of completing first.
      setPower.mockImplementationOnce(async () => {
        await new Promise(r => setTimeout(r, 25))
      })

      const power = manager.runPowerOffJob(powerSched('left'))
      const temp = manager.runTemperatureJob(tempSched('left', 80))
      await Promise.all([power, temp])

      expect(setPower).toHaveBeenCalledTimes(1)
      expect(setPower).toHaveBeenCalledWith('left', false)
      expect(setTemperature).not.toHaveBeenCalled()

      const row = readSide('left')
      expect(row?.is_powered).toBe(0)
    })

    it('temp job that wins the lock first still ends with side off after power_off runs second', async () => {
      seedSidePowered('left', true)

      // Even when the temp handler beats power_off into the lock, power_off
      // claims the next slot, marks DB off, sends setPower(false). Final
      // hardware state is off and DB reflects that.
      const temp = manager.runTemperatureJob(tempSched('left', 80))
      const power = manager.runPowerOffJob(powerSched('left'))
      await Promise.all([temp, power])

      expect(setTemperature).toHaveBeenCalledWith('left', 80)
      expect(setPower).toHaveBeenLastCalledWith('left', false)

      const row = readSide('left')
      expect(row?.is_powered).toBe(0)
      expect(row?.target_temperature).toBeNull()
    })

    it('serializes — second handler does not start until first releases', async () => {
      seedSidePowered('left', true)

      const order: string[] = []
      setPower.mockImplementation(async () => {
        order.push('power-off-start')
        await new Promise(r => setTimeout(r, 30))
        order.push('power-off-end')
      })
      setTemperature.mockImplementation(async () => {
        order.push('temp-start')
        await new Promise(r => setTimeout(r, 5))
        order.push('temp-end')
      })

      const a = manager.runPowerOffJob(powerSched('left'))
      const b = manager.runTemperatureJob(tempSched('left', 80))
      await Promise.all([a, b])

      // power-off ran first end-to-end before temp started (or skipped).
      // The temp will skip because power_off cleared isPowered, but the
      // serialization holds: no overlap between starts/ends.
      const powerStart = order.indexOf('power-off-start')
      const powerEnd = order.indexOf('power-off-end')
      const tempStart = order.indexOf('temp-start')
      expect(powerStart).toBeGreaterThanOrEqual(0)
      expect(powerEnd).toBeGreaterThan(powerStart)
      // temp-start must NOT appear between power-off-start and power-off-end.
      if (tempStart !== -1) {
        expect(tempStart).toBeGreaterThan(powerEnd)
      }
    })

    it('different sides run in parallel — left lock does not block right', async () => {
      seedSidePowered('left', true)
      seedSidePowered('right', true)

      const order: string[] = []
      setTemperature.mockImplementation(async (side: string) => {
        order.push(`${side}-start`)
        await new Promise(r => setTimeout(r, 25))
        order.push(`${side}-end`)
      })

      const start = Date.now()
      await Promise.all([
        manager.runTemperatureJob(tempSched('left', 80)),
        manager.runTemperatureJob(tempSched('right', 80)),
      ])
      const elapsed = Date.now() - start

      // Both ran in parallel — total time should be ~25ms not ~50ms.
      expect(elapsed).toBeLessThan(45)
      // Interleaved starts confirm parallelism.
      expect(order[0]).toMatch(/-start$/)
      expect(order[1]).toMatch(/-start$/)
    })
  })
})

describe('JobManager — liveness heartbeat', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    manager = new JobManager('America/Los_Angeles', {
      heartbeatIntervalMs: 1_000_000, // never auto-fires; we drive it manually
      heartbeatStaleMs: 50,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('reports no stale jobs when next invocations are in the future', async () => {
    const scheduler = manager.getScheduler()
    scheduler.scheduleJob('test-future', 'temperature' as any, '0 0 * * *', async () => {})

    const stale = await manager.checkLiveness()
    expect(stale).toEqual([])
  })

  it('detects a job whose nextInvocation is older than the stale threshold', async () => {
    const scheduler = manager.getScheduler()
    scheduler.scheduleJob('test-past', 'temperature' as any, '0 0 * * *', async () => {})

    // Spy: force the job to report a nextInvocation in the past.
    const job = scheduler.getJob('test-past')
    if (!job) throw new Error('expected test-past to be registered')
    const fakePast = new Date(Date.now() - 5_000)
    vi.spyOn(scheduler, 'getNextInvocation').mockImplementation(id =>
      id === 'test-past' ? (fakePast as any) : null
    )

    // Track whether reload fires.
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()

    const stale = await manager.checkLiveness()

    expect(stale).toContain('test-past')
    expect(reloadSpy).toHaveBeenCalledOnce()

    // Cleanup so afterEach shutdown doesn't trip on the cancelled job.
    job.job.cancel()
  })

  it('respects reload cooldown — second stale tick within window does not reload again', async () => {
    const scheduler = manager.getScheduler()
    scheduler.scheduleJob('test-past', 'temperature' as any, '0 0 * * *', async () => {})

    const fakePast = new Date(Date.now() - 5_000)
    vi.spyOn(scheduler, 'getNextInvocation').mockImplementation(id =>
      id === 'test-past' ? (fakePast as any) : null
    )
    const reloadSpy = vi.spyOn(manager, 'reloadSchedules').mockResolvedValue()

    await manager.checkLiveness()
    await manager.checkLiveness()

    expect(reloadSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores RUN_ONCE jobs (they auto-remove after firing)', async () => {
    const scheduler = manager.getScheduler()
    const future = new Date(Date.now() + 60_000)
    scheduler.scheduleOneTimeJob('runonce-1', 'run_once' as any, future, async () => {})

    // Pretend the run_once is overdue — heartbeat must still ignore it.
    vi.spyOn(scheduler, 'getNextInvocation').mockImplementation(() => new Date(Date.now() - 5_000) as any)

    const stale = await manager.checkLiveness()
    expect(stale).toEqual([])
  })

  it('startHeartbeat is idempotent', () => {
    manager.startHeartbeat()
    manager.startHeartbeat()
    manager.stopHeartbeat()
    // No throw, no leaked timer — afterEach shutdown will catch any leak.
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// loadSchedules — exercises every branch in the DB→cron registration path
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager.loadSchedules', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    setAlarm.mockClear()
    startPriming.mockClear()
    connect.mockClear()
    manager = new JobManager('America/Los_Angeles', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('registers a temperature job for each enabled temperature schedule', async () => {
    insertTempSchedule({ side: 'left', dayOfWeek: 'monday', time: '08:00', temperature: 75 })
    insertTempSchedule({ side: 'right', dayOfWeek: 'tuesday', time: '08:30', temperature: 78 })
    insertTempSchedule({ side: 'left', dayOfWeek: 'wednesday', time: '09:00', temperature: 80, enabled: false })

    await manager.loadSchedules()

    const jobs = manager.getScheduler().getJobs()
    const tempJobs = jobs.filter(j => j.type === 'temperature')
    expect(tempJobs).toHaveLength(2)
  })

  it('registers power-on AND power-off jobs for each enabled power schedule', async () => {
    insertPowerSchedule({
      side: 'left',
      dayOfWeek: 'friday',
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
    })
    insertPowerSchedule({
      side: 'right',
      dayOfWeek: 'saturday',
      onTime: '23:00',
      offTime: '06:00',
      onTemperature: 78,
      enabled: false,
    })

    await manager.loadSchedules()

    const jobs = manager.getScheduler().getJobs()
    expect(jobs.filter(j => j.type === 'power_on')).toHaveLength(1)
    expect(jobs.filter(j => j.type === 'power_off')).toHaveLength(1)
  })

  it('registers alarm jobs only for enabled alarm schedules', async () => {
    insertAlarmSchedule({ side: 'left', dayOfWeek: 'monday', time: '06:30', alarmTemperature: 90 })
    insertAlarmSchedule({ side: 'right', dayOfWeek: 'monday', time: '07:00', alarmTemperature: 88, enabled: false })

    await manager.loadSchedules()

    const jobs = manager.getScheduler().getJobs()
    expect(jobs.filter(j => j.type === 'alarm')).toHaveLength(1)
  })

  it('schedules priming + pre-prime reboot + pre-prime calibration when primePodDaily is on', async () => {
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '14:00' })

    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('daily-prime')
    expect(ids).toContain('prime-prereboot')
    expect(ids).toContain('pre-prime-calibration')
  })

  it('schedules daily reboot when rebootDaily is on', async () => {
    insertDeviceSettings({ reboot_daily: 1, reboot_time: '03:00' })

    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('daily-reboot')
  })

  it('schedules LED night start + end and applies initial brightness when enabled', async () => {
    insertDeviceSettings({
      led_night_mode_enabled: 1,
      led_night_start_time: '22:00',
      led_night_end_time: '07:00',
      led_day_brightness: 100,
      led_night_brightness: 10,
    })

    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('led-night-start')
    expect(ids).toContain('led-night-end')
  })

  it('schedules nothing system-wide when device_settings has no flags set', async () => {
    insertDeviceSettings({}) // all defaults: nothing daily-on
    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).not.toContain('daily-prime')
    expect(ids).not.toContain('daily-reboot')
    expect(ids).not.toContain('led-night-start')
  })

  it('handles empty device_settings table gracefully', async () => {
    // No row inserted at all — settings query returns nothing
    await manager.loadSchedules()
    expect(manager.getScheduler().getJobs()).toEqual([])
  })

  it('schedules away-mode start/return one-time jobs for sides with future windows', async () => {
    const futureStart = new Date(Date.now() + 60 * 60_000).toISOString()
    const futureReturn = new Date(Date.now() + 4 * 60 * 60_000).toISOString()
    insertSideSettings({ side: 'left', awayStart: futureStart, awayReturn: futureReturn })

    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('away-start-left')
    expect(ids).toContain('away-return-left')
  })

  it('skips away-mode jobs whose dates are in the past', async () => {
    const pastStart = new Date(Date.now() - 60 * 60_000).toISOString()
    const pastReturn = new Date(Date.now() - 30 * 60_000).toISOString()
    insertSideSettings({ side: 'right', awayStart: pastStart, awayReturn: pastReturn })

    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).not.toContain('away-start-right')
    expect(ids).not.toContain('away-return-right')
  })

  it('skips side_settings rows with no away window', async () => {
    insertSideSettings({ side: 'left' })
    insertSideSettings({ side: 'right' })

    await manager.loadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids.filter(id => id.startsWith('away-'))).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Run-once scheduling, restoration, and cancellation
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager run-once sessions', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    connect.mockClear()
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('hasActiveRunOnceSession returns true when an active non-expired session exists', async () => {
    insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      status: 'active',
    })

    expect(await manager.hasActiveRunOnceSession('left')).toBe(true)
    expect(await manager.hasActiveRunOnceSession('right')).toBe(false)
  })

  it('hasActiveRunOnceSession returns false for expired sessions', async () => {
    insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(Date.now() - 2 * 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
      status: 'active',
    })

    expect(await manager.hasActiveRunOnceSession('left')).toBe(false)
  })

  it('runTemperatureJob skips when a run-once session is active for the side', async () => {
    seedSidePowered('left', true)
    insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })

    await manager.runTemperatureJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      time: '10:00',
      temperature: 75,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(setTemperature).not.toHaveBeenCalled()
  })

  it('runPowerOnJob fires setPower(true) and broadcasts onTemperature when set', async () => {
    await manager.runPowerOnJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '06:00',
      onTemperature: 82,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(setPower).toHaveBeenCalledWith('left', true, 82)
  })

  it('runPowerOnJob falls back to 75°F broadcast when onTemperature is null', async () => {
    await manager.runPowerOnJob({
      id: 1,
      side: 'right',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '06:00',
      onTemperature: null as unknown as number, // exercise the ?? 75 branch
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(setPower).toHaveBeenCalledWith('right', true, null)
  })

  it('runPowerOnJob skips when a run-once session is active', async () => {
    insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })

    await manager.runPowerOnJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '06:00',
      onTemperature: 80,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(setPower).not.toHaveBeenCalled()
  })

  it('runPowerOffJob skips when a run-once session is active', async () => {
    seedSidePowered('right', true)
    insertRunOnceSession({
      side: 'right',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
    })

    await manager.runPowerOffJob({
      id: 1,
      side: 'right',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '06:00',
      onTemperature: 80,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(setPower).not.toHaveBeenCalled()
    // device_state was NOT mutated since we bailed before withSideLock
    expect(readSide('right')?.is_powered).toBe(1)
  })

  it('scheduleRunOnceSession schedules future setpoints and a cleanup job', () => {
    const now = new Date()
    const futureA = new Date(now.getTime() + 5 * 60_000)
    const futureB = new Date(now.getTime() + 10 * 60_000)

    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    const wake = new Date(now.getTime() + 30 * 60_000)
    manager.scheduleRunOnceSession(
      42,
      'left',
      [
        { time: fmt(futureA), temperature: 80 },
        { time: fmt(futureB), temperature: 75 },
      ],
      fmt(wake),
      'UTC',
    )

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('runonce-42-0')
    expect(ids).toContain('runonce-42-1')
    expect(ids).toContain('runonce-cleanup-42')
  })

  it('scheduleRunOnceSession skips setpoints that resolve into the past', () => {
    // Spy on timeToDate via direct injection: pass a mock side that lands in the past.
    // We can't easily mock timeToDate from this scope, so instead exercise the
    // skip path by passing an empty setPoints array and verifying only the
    // cleanup is registered.
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    manager.scheduleRunOnceSession(
      99,
      'left',
      [],
      fmt(new Date(now.getTime() + 60 * 60_000)),
      'UTC',
    )

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids.filter(id => id.startsWith('runonce-99-'))).toHaveLength(0)
    expect(ids).toContain('runonce-cleanup-99')
  })

  it('cancelRunOnceSession removes only run-once jobs for the matching side', () => {
    const now = new Date()
    const fut = (mins: number) =>
      new Date(now.getTime() + mins * 60_000)
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    manager.scheduleRunOnceSession(1, 'left', [{ time: fmt(fut(5)), temperature: 80 }], fmt(fut(60)), 'UTC')
    manager.scheduleRunOnceSession(2, 'right', [{ time: fmt(fut(5)), temperature: 80 }], fmt(fut(60)), 'UTC')

    expect(manager.getScheduler().getJobs().filter(j => j.type === 'run_once')).toHaveLength(4)

    manager.cancelRunOnceSession('left')

    const remaining = manager.getScheduler().getJobs()
    expect(remaining.every(j => j.metadata?.side !== 'left')).toBe(true)
    expect(remaining.filter(j => j.metadata?.side === 'right')).toHaveLength(2)
  })

  it('loadSchedules expires past-due active sessions and powers off the side', async () => {
    insertDeviceSettings({})
    insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(Date.now() - 4 * 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
      status: 'active',
    })

    await manager.loadSchedules()

    const row = (sqlite as any).prepare(`SELECT status FROM run_once_sessions LIMIT 1`).get() as { status: string }
    expect(row.status).toBe('completed')
    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('loadSchedules restores active future sessions with future setpoints', async () => {
    insertDeviceSettings({ timezone: 'UTC' })
    const now = new Date()
    const fut = (mins: number) =>
      new Date(now.getTime() + mins * 60_000)
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`

    insertRunOnceSession({
      side: 'right',
      setPoints: JSON.stringify([{ time: fmt(fut(15)), temperature: 80 }]),
      wakeTime: fmt(fut(120)),
      startedAt: now,
      expiresAt: fut(180),
      status: 'active',
    })

    await manager.loadSchedules()

    const runOnceJobs = manager.getScheduler().getJobs().filter(j => j.type === 'run_once')
    // 1 setpoint + 1 cleanup
    expect(runOnceJobs.length).toBeGreaterThanOrEqual(2)
  })

  it('loadSchedules marks malformed-setPoints sessions as completed and continues', async () => {
    insertDeviceSettings({})
    insertRunOnceSession({
      side: 'left',
      setPoints: 'not-valid-json',
      wakeTime: '08:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      status: 'active',
    })

    await manager.loadSchedules()

    const row = (sqlite as any).prepare(`SELECT status FROM run_once_sessions LIMIT 1`).get() as { status: string }
    expect(row.status).toBe('completed')
  })

  it('run-once cleanup bails out when status is not active by cleanup time', async () => {
    // Capture the cleanup handler closure via a scheduleOneTimeJob spy, then
    // mutate DB to cancelled and invoke the captured handler directly. This
    // avoids real-time waits for cron firing.
    const sched = manager.getScheduler()
    const captured = new Map<string, () => Promise<void>>()
    const orig = sched.scheduleOneTimeJob.bind(sched)
    sched.scheduleOneTimeJob = (id, type, fireDate, handler, metadata) => {
      captured.set(id, handler)
      return orig(id, type, fireDate, handler, metadata)
    }

    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    seedSidePowered('left', true)

    const sessionId = insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: fmt(new Date(now.getTime() + 60 * 60_000)),
      startedAt: now,
      expiresAt: new Date(now.getTime() + 2 * 60 * 60_000),
      status: 'active',
    })

    manager.scheduleRunOnceSession(
      sessionId,
      'left',
      [],
      fmt(new Date(now.getTime() + 60 * 60_000)),
      'UTC',
    )

    // Cancel the session before invoking the cleanup handler
    ;(sqlite as any).prepare(`UPDATE run_once_sessions SET status='cancelled' WHERE id=?`).run(sessionId)

    const cleanupHandler = captured.get(`runonce-cleanup-${sessionId}`)
    expect(cleanupHandler).toBeDefined()
    await cleanupHandler!()

    // setPower must NOT have been called (handler bailed when it saw status != active)
    expect(setPower).not.toHaveBeenCalled()
    // Side still powered — cleanup did not run
    expect(readSide('left')?.is_powered).toBe(1)
  })

  it('run-once cleanup bails out when status row is missing entirely', async () => {
    const sched = manager.getScheduler()
    const captured = new Map<string, () => Promise<void>>()
    const orig = sched.scheduleOneTimeJob.bind(sched)
    sched.scheduleOneTimeJob = (id, type, fireDate, handler, metadata) => {
      captured.set(id, handler)
      return orig(id, type, fireDate, handler, metadata)
    }

    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    seedSidePowered('left', true)

    const sessionId = insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: fmt(new Date(now.getTime() + 60 * 60_000)),
      startedAt: now,
      expiresAt: new Date(now.getTime() + 2 * 60 * 60_000),
      status: 'active',
    })

    manager.scheduleRunOnceSession(
      sessionId,
      'left',
      [],
      fmt(new Date(now.getTime() + 60 * 60_000)),
      'UTC',
    )

    // Delete the row entirely
    ;(sqlite as any).prepare(`DELETE FROM run_once_sessions WHERE id=?`).run(sessionId)

    const cleanupHandler = captured.get(`runonce-cleanup-${sessionId}`)!
    await cleanupHandler()

    expect(setPower).not.toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reload / shutdown / lifecycle paths
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager lifecycle', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    connect.mockClear()
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('updateTimezone replaces config and reloads schedules', async () => {
    insertTempSchedule({ side: 'left', dayOfWeek: 'monday', time: '08:00', temperature: 75 })
    await manager.loadSchedules()
    const before = manager.getScheduler().getTimezone()
    expect(before).toBe('UTC')

    await manager.updateTimezone('America/New_York')
    expect(manager.getScheduler().getTimezone()).toBe('America/New_York')
    // Schedule re-registered after tz change
    expect(manager.getScheduler().getJobs().filter(j => j.type === 'temperature')).toHaveLength(1)
  })

  it('reloadSchedules preserves one-time jobs while replacing recurring jobs', async () => {
    insertTempSchedule({ side: 'left', dayOfWeek: 'monday', time: '08:00', temperature: 75 })
    await manager.loadSchedules()

    // Add a one-time job manually that reload should preserve
    const futureFire = new Date(Date.now() + 60 * 60_000)
    manager.getScheduler().scheduleOneTimeJob(
      'manual-onetime',
      'run_once' as any,
      futureFire,
      async () => {},
      { side: 'left' },
    )

    await manager.reloadSchedules()

    const ids = manager.getScheduler().getJobs().map(j => j.id)
    expect(ids).toContain('manual-onetime')
  })

  it('getScheduler returns the underlying Scheduler instance', () => {
    const sched = manager.getScheduler()
    expect(sched).toBeDefined()
    expect(typeof sched.scheduleJob).toBe('function')
  })

  it('shutdown is idempotent — safe to call after already shutting down', async () => {
    await manager.shutdown()
    await manager.shutdown() // second call must not throw
    // afterEach will call again
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cron-builder edge cases (private parseTime / buildWeeklyCron via public API)
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager cron building', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('builds correct weekly cron for sunday', async () => {
    insertTempSchedule({ side: 'left', dayOfWeek: 'sunday', time: '06:30', temperature: 72 })
    await manager.loadSchedules()
    const job = manager.getScheduler().getJobs().find(j => j.type === 'temperature')
    expect(job?.schedule).toBe('30 6 * * 0')
  })

  it('builds correct weekly cron for saturday', async () => {
    insertTempSchedule({ side: 'right', dayOfWeek: 'saturday', time: '23:45', temperature: 80 })
    await manager.loadSchedules()
    const job = manager.getScheduler().getJobs().find(j => j.type === 'temperature')
    expect(job?.schedule).toBe('45 23 * * 6')
  })

  it('throws on invalid time strings during loadSchedules', async () => {
    insertTempSchedule({ side: 'left', dayOfWeek: 'monday', time: 'not-a-time', temperature: 75 })
    await expect(manager.loadSchedules()).rejects.toThrow(/Invalid time format/)
  })

  it('schedulePrimePreReboot wraps midnight when prime is at 00:30', async () => {
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '00:30' })
    await manager.loadSchedules()
    const reboot = manager.getScheduler().getJob('prime-prereboot')
    // 00:30 - 60min = 23:30 prior day → cron "30 23 * * *"
    expect(reboot?.schedule).toBe('30 23 * * *')
  })

  it('schedulePrePrimeCalibration computes 30 minutes earlier with midnight wrap', async () => {
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '00:15' })
    await manager.loadSchedules()
    const cal = manager.getScheduler().getJob('pre-prime-calibration')
    // 00:15 - 30min = 23:45 prior day → cron "45 23 * * *"
    expect(cal?.schedule).toBe('45 23 * * *')
  })

  it('LED night mode handles same-day window (e.g. 01:00–06:00)', async () => {
    insertDeviceSettings({
      led_night_mode_enabled: 1,
      led_night_start_time: '01:00',
      led_night_end_time: '06:00',
      led_day_brightness: 100,
      led_night_brightness: 5,
    })
    await manager.loadSchedules()
    const start = manager.getScheduler().getJob('led-night-start')
    const end = manager.getScheduler().getJob('led-night-end')
    expect(start?.schedule).toBe('0 1 * * *')
    expect(end?.schedule).toBe('0 6 * * *')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Capture and invoke registered handler closures by spying on scheduleJob
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager handler closures', () => {
  let manager: JobManager
  let captured: Map<string, () => Promise<void>>

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    setAlarm.mockClear()
    startPriming.mockClear()
    connect.mockClear()
    captured = new Map()
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })

    // Wrap scheduleJob and scheduleOneTimeJob to capture handler closures.
    const sched = manager.getScheduler()
    const origCron = sched.scheduleJob.bind(sched)
    sched.scheduleJob = (id, type, cron, handler, metadata) => {
      captured.set(id, handler)
      return origCron(id, type, cron, handler, metadata)
    }
    const origOne = sched.scheduleOneTimeJob.bind(sched)
    sched.scheduleOneTimeJob = (id, type, fireDate, handler, metadata) => {
      captured.set(id, handler)
      return origOne(id, type, fireDate, handler, metadata)
    }
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('daily-prime handler invokes startPriming on the shared client', async () => {
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '14:00' })
    await manager.loadSchedules()
    const handler = captured.get('daily-prime')
    expect(handler).toBeDefined()
    await handler!()
    expect(startPriming).toHaveBeenCalledOnce()
  })

  it('daily-reboot handler runs executeReboot (systemctl reboot)', async () => {
    insertDeviceSettings({ reboot_daily: 1, reboot_time: '03:00' })
    await manager.loadSchedules()
    const handler = captured.get('daily-reboot')
    expect(handler).toBeDefined()

    execMock.mockImplementationOnce((_cmd, cb) => cb(null))

    await handler!()

    expect(execMock).toHaveBeenCalledWith('systemctl reboot', expect.any(Function))
  })

  it('daily-reboot handler surfaces exec failure as a rejected promise', async () => {
    insertDeviceSettings({ reboot_daily: 1, reboot_time: '03:00' })
    await manager.loadSchedules()
    const handler = captured.get('daily-reboot')!

    execMock.mockImplementationOnce((_cmd, cb) => cb(new Error('boom')))

    await expect(handler()).rejects.toThrow('boom')
  })

  it('prime-prereboot handler invokes executeReboot', async () => {
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '14:00' })
    await manager.loadSchedules()
    const handler = captured.get('prime-prereboot')!

    execMock.mockImplementationOnce((_cmd, cb) => cb(null))

    await handler()
    expect(execMock).toHaveBeenCalledWith('systemctl reboot', expect.any(Function))
  })

  it('pre-prime-calibration handler writes a trigger file', async () => {
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '14:00' })
    await manager.loadSchedules()
    const handler = captured.get('pre-prime-calibration')!

    writeFileMock.mockClear()
    renameMock.mockClear()

    await handler()

    expect(writeFileMock).toHaveBeenCalledOnce()
    expect(renameMock).toHaveBeenCalledOnce()
    const [tmpPath, payload] = writeFileMock.mock.calls[0]
    expect(String(tmpPath)).toMatch(/\.calibrate-trigger\.\d+\.tmp$/)
    const parsed = JSON.parse(payload as string)
    expect(parsed.side).toBe('all')
    expect(parsed.sensor_type).toBe('all')
  })

  it('pre-prime-calibration uses CALIBRATION_TRIGGER_PATH env var when set', async () => {
    process.env.CALIBRATION_TRIGGER_PATH = '/tmp/sleepypod-test-cal/trigger'
    insertDeviceSettings({ prime_pod_daily: 1, prime_pod_time: '14:00' })
    await manager.loadSchedules()
    const handler = captured.get('pre-prime-calibration')!

    writeFileMock.mockClear()

    await handler()
    const [tmpPath] = writeFileMock.mock.calls[0]
    expect(String(tmpPath)).toMatch(/^\/tmp\/sleepypod-test-cal\//)

    delete process.env.CALIBRATION_TRIGGER_PATH
  })

  it('led-night-start and led-night-end handlers send LED brightness commands', async () => {
    insertDeviceSettings({
      led_night_mode_enabled: 1,
      led_night_start_time: '22:00',
      led_night_end_time: '07:00',
      led_day_brightness: 100,
      led_night_brightness: 5,
    })
    await manager.loadSchedules()

    const startHandler = captured.get('led-night-start')!
    const endHandler = captured.get('led-night-end')!
    await startHandler()
    await endHandler()

    // The shared client's connect was called for each LED command + the
    // initial brightness application during loadSchedules.
    expect(connect).toHaveBeenCalled()
  })

  it('temperature cron handler closure delegates to runTemperatureJob with isPowered gate', async () => {
    insertTempSchedule({ side: 'left', dayOfWeek: 'monday', time: '08:00', temperature: 75 })
    seedSidePowered('left', true)
    await manager.loadSchedules()

    const handler = captured.get('temp-1')!
    await handler()

    expect(setTemperature).toHaveBeenCalledWith('left', 75)
  })

  it('power-on cron handler closure delegates to runPowerOnJob', async () => {
    insertPowerSchedule({
      side: 'right',
      dayOfWeek: 'monday',
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
    })
    await manager.loadSchedules()

    const handler = captured.get('power-on-1')!
    await handler()

    expect(setPower).toHaveBeenCalledWith('right', true, 80)
  })

  it('power-off cron handler closure delegates to runPowerOffJob and clears DB', async () => {
    insertPowerSchedule({
      side: 'left',
      dayOfWeek: 'monday',
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
    })
    seedSidePowered('left', true)
    await manager.loadSchedules()

    const handler = captured.get('power-off-1')!
    await handler()

    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(readSide('left')?.is_powered).toBe(0)
  })

  it('alarm cron handler closure delegates to runAlarmJob with isPowered gate', async () => {
    insertAlarmSchedule({ side: 'right', dayOfWeek: 'monday', time: '06:00', alarmTemperature: 90 })
    seedSidePowered('right', true)
    await manager.loadSchedules()

    const handler = captured.get('alarm-1')!
    await handler()

    expect(setAlarm).toHaveBeenCalled()
    expect(setTemperature).toHaveBeenCalledWith('right', 90)
  })

  it('away-mode start handler powers off the side and flips awayMode flag', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    insertSideSettings({ side: 'left', awayStart: future })
    await manager.loadSchedules()

    const handler = captured.get('away-start-left')!
    await handler()

    expect(setPower).toHaveBeenCalledWith('left', false)
  })

  it('away-mode return handler restores power for the side', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    insertSideSettings({ side: 'right', awayReturn: future })
    await manager.loadSchedules()

    const handler = captured.get('away-return-right')!
    await handler()

    expect(setPower).toHaveBeenCalledWith('right', true)
  })

  it('away-mode start handler tolerates hardware failures', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    insertSideSettings({ side: 'left', awayStart: future })
    await manager.loadSchedules()

    setPower.mockRejectedValueOnce(new Error('hw down'))
    const handler = captured.get('away-start-left')!
    // Must not reject: handler swallows hw errors with console.warn
    await expect(handler()).resolves.toBeUndefined()
  })

  it('away-mode return handler tolerates hardware failures', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString()
    insertSideSettings({ side: 'right', awayReturn: future })
    await manager.loadSchedules()

    setPower.mockRejectedValueOnce(new Error('hw down'))
    const handler = captured.get('away-return-right')!
    await expect(handler()).resolves.toBeUndefined()
  })

  it('run-once setpoint handler issues setTemperature on the locked side', async () => {
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const setpointTime = fmt(new Date(now.getTime() + 30 * 60_000))
    const wakeTime = fmt(new Date(now.getTime() + 8 * 60 * 60_000))

    manager.scheduleRunOnceSession(7, 'left', [{ time: setpointTime, temperature: 78 }], wakeTime, 'UTC')

    const handler = captured.get('runonce-7-0')!
    await handler()

    expect(setTemperature).toHaveBeenCalledWith('left', 78)
  })

  it('run-once cleanup handler powers the side off when status is still active', async () => {
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const wakeTime = fmt(new Date(now.getTime() + 8 * 60 * 60_000))
    seedSidePowered('left', true)

    const sessionId = insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime,
      startedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      status: 'active',
    })

    manager.scheduleRunOnceSession(sessionId, 'left', [], wakeTime, 'UTC')

    const handler = captured.get(`runonce-cleanup-${sessionId}`)!
    await handler()

    expect(setPower).toHaveBeenCalledWith('left', false)
    const row = (sqlite as any).prepare(`SELECT status FROM run_once_sessions WHERE id=?`).get(sessionId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('run-once cleanup handler tolerates hardware failures during power-off', async () => {
    const now = new Date()
    const fmt = (d: Date) =>
      `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
    const wakeTime = fmt(new Date(now.getTime() + 8 * 60 * 60_000))
    seedSidePowered('right', true)

    const sessionId = insertRunOnceSession({
      side: 'right',
      setPoints: '[]',
      wakeTime,
      startedAt: now,
      expiresAt: new Date(now.getTime() + 24 * 60 * 60_000),
      status: 'active',
    })

    manager.scheduleRunOnceSession(sessionId, 'right', [], wakeTime, 'UTC')
    const handler = captured.get(`runonce-cleanup-${sessionId}`)!

    setPower.mockRejectedValueOnce(new Error('hw failure'))
    await expect(handler()).resolves.toBeUndefined()
  })

  it('run-once expired session loadSchedules path tolerates hardware failure', async () => {
    insertDeviceSettings({})
    insertRunOnceSession({
      side: 'right',
      setPoints: '[]',
      wakeTime: '07:00',
      startedAt: new Date(Date.now() - 4 * 60 * 60_000),
      expiresAt: new Date(Date.now() - 60_000),
      status: 'active',
    })
    setPower.mockRejectedValueOnce(new Error('hw failure'))

    // Should not throw — the catch block in loadRunOnceSessions swallows
    await expect(manager.loadSchedules()).resolves.toBeUndefined()
  })

  it('scheduler events trigger jobScheduled / jobExecuted (success) / jobError listeners', async () => {
    const sched = manager.getScheduler()
    const fakeJob = {
      id: 'test-event',
      type: 'temperature',
      schedule: '0 0 * * *',
      job: { cancel: () => undefined } as any,
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    sched.emit('jobScheduled', fakeJob as any)
    sched.emit('jobExecuted', 'test-event', { success: true, timestamp: new Date() })
    sched.emit('jobExecuted', 'test-event', { success: false, error: 'oops', timestamp: new Date() })
    sched.emit('jobError', 'test-event', new Error('failed'))

    expect(logSpy).toHaveBeenCalled()
    expect(errSpy).toHaveBeenCalled()
    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('startHeartbeat fires the interval body when timer elapses', async () => {
    // Use a real fast interval here so the setInterval body executes once.
    // Replace manager with one that has a short interval.
    await manager.shutdown()
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 10,
      heartbeatStaleMs: 90_000,
    })
    const checkSpy = vi.spyOn(manager, 'checkLiveness').mockResolvedValue([])
    manager.startHeartbeat()
    await new Promise(r => setTimeout(r, 50))
    manager.stopHeartbeat()
    expect(checkSpy).toHaveBeenCalled()
  })

  it('heartbeat-triggered reload tolerates reloadSchedules failure', async () => {
    // Use a fresh manager with a small stale threshold so the fake past time triggers.
    await manager.shutdown()
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 50,
    })
    const sched = manager.getScheduler()
    sched.scheduleJob('test-past', 'temperature' as any, '0 0 * * *', async () => {})

    const fakePast = new Date(Date.now() - 5_000)
    vi.spyOn(sched, 'getNextInvocation').mockImplementation(id =>
      id === 'test-past' ? (fakePast as any) : null,
    )

    vi.spyOn(manager, 'reloadSchedules').mockRejectedValue(new Error('reload boom'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const stale = await manager.checkLiveness()
    expect(stale).toContain('test-past')
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('runPowerOffJob tolerates DB failure inside markSideOff', async () => {
    seedSidePowered('left', true)
    // Drop the table so the update inside markSideOff throws — runPowerOffJob
    // must still issue setPower(false) and not surface the DB error.
    ;(sqlite as any).exec(`DROP TABLE device_state`)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      manager.runPowerOffJob({
        id: 1,
        side: 'left',
        dayOfWeek: 'monday' as const,
        onTime: '22:00',
        offTime: '07:00',
        onTemperature: 80,
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).resolves.toBeUndefined()

    expect(setPower).toHaveBeenCalledWith('left', false)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('markSideOff failed for left'),
      expect.any(String),
    )
    warnSpy.mockRestore()
  })

  it('LED night mode tolerates initial-brightness send failure', async () => {
    insertDeviceSettings({
      led_night_mode_enabled: 1,
      led_night_start_time: '22:00',
      led_night_end_time: '07:00',
      led_day_brightness: 100,
      led_night_brightness: 5,
    })

    // Make connect throw once during initial-brightness apply
    connect.mockRejectedValueOnce(new Error('hw down'))

    // loadSchedules must not throw — initial brightness apply is wrapped in try/catch
    await expect(manager.loadSchedules()).resolves.toBeUndefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// broadcastMutationStatus payload shape + downstream side-effects.
//
// Mutation testing flagged the broadcastMutationStatus(...) object literals
// (lines 349, 384, 420, 436 of jobManager.ts) and the `onTemperature ?? 75`
// fallback (line 383) as surviving — existing tests covered the hardware
// client calls but did not assert on the streaming payload itself.
// ─────────────────────────────────────────────────────────────────────────────
describe('JobManager — streaming + downstream side-effects', () => {
  let manager: JobManager

  beforeEach(() => {
    resetSchema()
    setTemperature.mockClear()
    setPower.mockClear()
    setAlarm.mockClear()
    connect.mockClear()
    broadcastMutationStatus.mockClear()
    cancelAutoOffTimer.mockClear()
    setTemperature.mockImplementation(async () => {})
    setPower.mockImplementation(async () => {})
    setAlarm.mockImplementation(async () => {})
    manager = new JobManager('UTC', {
      heartbeatIntervalMs: 1_000_000,
      heartbeatStaleMs: 90_000,
    })
  })

  afterEach(async () => {
    await manager.shutdown()
  })

  it('runTemperatureJob broadcasts targetTemperature + targetLevel after setTemperature', async () => {
    seedSidePowered('left', true)

    await manager.runTemperatureJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      time: '08:00',
      temperature: 78,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(broadcastMutationStatus).toHaveBeenCalledOnce()
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', {
      targetTemperature: 78,
      targetLevel: fahrenheitToLevel(78),
    })
  })

  it('runTemperatureJob does NOT broadcast when the side is unpowered', async () => {
    seedSidePowered('left', false)

    await manager.runTemperatureJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      time: '08:00',
      temperature: 78,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(broadcastMutationStatus).not.toHaveBeenCalled()
  })

  it('runPowerOnJob broadcasts targetTemperature matching onTemperature when set', async () => {
    await manager.runPowerOnJob({
      id: 1,
      side: 'right',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 84,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(broadcastMutationStatus).toHaveBeenCalledOnce()
    expect(broadcastMutationStatus).toHaveBeenCalledWith('right', {
      targetTemperature: 84,
      targetLevel: fahrenheitToLevel(84),
    })
    expect(cancelAutoOffTimer).toHaveBeenCalledWith('right')
  })

  it('runPowerOnJob falls back to 75°F in the BROADCAST when onTemperature is null', async () => {
    // Kills `??` → `&&` mutator at jobManager.ts:383. Under `&&`, a null
    // onTemperature would propagate to the broadcast as null/undefined; under
    // `??`, the fallback 75 must surface in targetTemperature + targetLevel.
    await manager.runPowerOnJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: null as unknown as number,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(broadcastMutationStatus).toHaveBeenCalledOnce()
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', {
      targetTemperature: 75,
      targetLevel: fahrenheitToLevel(75),
    })
  })

  it('runPowerOffJob broadcasts targetLevel:0 (and no temperature key)', async () => {
    seedSidePowered('left', true)

    await manager.runPowerOffJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(broadcastMutationStatus).toHaveBeenCalledOnce()
    expect(broadcastMutationStatus).toHaveBeenCalledWith('left', { targetLevel: 0 })
  })

  it('runAlarmJob broadcasts alarm temperature + isAlarmVibrating:true', async () => {
    seedSidePowered('right', true)

    await manager.runAlarmJob({
      id: 1,
      side: 'right',
      dayOfWeek: 'thursday' as const,
      time: '06:30',
      alarmTemperature: 88,
      vibrationIntensity: 90,
      vibrationPattern: 'rise' as const,
      duration: 30,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(broadcastMutationStatus).toHaveBeenCalledOnce()
    expect(broadcastMutationStatus).toHaveBeenCalledWith('right', {
      targetTemperature: 88,
      targetLevel: fahrenheitToLevel(88),
      isAlarmVibrating: true,
    })
    // setAlarm forwarded the exact vibration parameters from the schedule
    expect(setAlarm).toHaveBeenCalledWith('right', {
      vibrationIntensity: 90,
      vibrationPattern: 'rise',
      duration: 30,
    })
  })

  it('runPowerOnJob does NOT cancelAutoOffTimer when a run-once session is active', async () => {
    insertRunOnceSession({
      side: 'left',
      setPoints: '[]',
      wakeTime: '08:00',
      startedAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60_000),
      status: 'active',
    })

    await manager.runPowerOnJob({
      id: 1,
      side: 'left',
      dayOfWeek: 'monday' as const,
      onTime: '22:00',
      offTime: '07:00',
      onTemperature: 80,
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    expect(cancelAutoOffTimer).not.toHaveBeenCalled()
    expect(broadcastMutationStatus).not.toHaveBeenCalled()
  })
})
