/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type BetterSqlite3 from 'better-sqlite3'

// ── Hardware mocks ────────────────────────────────────────────────────────
type AnyAsync = (...args: any[]) => Promise<void>
const setTemperature = vi.fn<AnyAsync>()
const setPower = vi.fn<AnyAsync>()
const setAlarm = vi.fn<AnyAsync>()
const connect = vi.fn<() => Promise<void>>()
setTemperature.mockResolvedValue(undefined)
setPower.mockResolvedValue(undefined)
setAlarm.mockResolvedValue(undefined)
connect.mockResolvedValue(undefined)

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ connect, setTemperature, setPower, setAlarm }),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: vi.fn(),
}))

vi.mock('@/src/services/autoOffWatcher', () => ({
  cancelAutoOffTimer: vi.fn(),
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
const { sqlite } = dbModule as typeof dbModule & { sqlite: BetterSqlite3.Database }

function resetSchema(): void {
  ;(sqlite as any).exec(`
    DROP TABLE IF EXISTS device_state;
    DROP TABLE IF EXISTS run_once_sessions;

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
  `)
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

    it('skips alarm + temperature when side is not powered', async () => {
      seedSidePowered('right', false)

      await manager.runAlarmJob(alarmSched('right'))

      expect(setTemperature).not.toHaveBeenCalled()
      expect(setAlarm).not.toHaveBeenCalled()
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
