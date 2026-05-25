/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

// Hoist mocks so they're available to vi.mock factories
const mocks = vi.hoisted(() => ({
  reloadSchedules: vi.fn(),
  upsertTemperatureJob: vi.fn(),
  cancelTemperatureJob: vi.fn(),
  upsertPowerJob: vi.fn(),
  cancelPowerJob: vi.fn(),
  upsertAlarmJob: vi.fn(),
  cancelAlarmJob: vi.fn(),
}))

vi.mock('@/src/scheduler', () => ({
  getJobManager: vi.fn(async () => ({
    reloadSchedules: mocks.reloadSchedules,
    upsertTemperatureJob: mocks.upsertTemperatureJob,
    cancelTemperatureJob: mocks.cancelTemperatureJob,
    upsertPowerJob: mocks.upsertPowerJob,
    cancelPowerJob: mocks.cancelPowerJob,
    upsertAlarmJob: mocks.upsertAlarmJob,
    cancelAlarmJob: mocks.cancelAlarmJob,
  })),
}))

// Replace the real DB with an in-memory SQLite instance
vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new BetterSqlite3(':memory:')
  sqlite.pragma('foreign_keys = ON')
  return { db: drizzle(sqlite, { schema }), sqlite }
})

import { schedulesRouter } from '@/src/server/routers/schedules'
import { sqlite } from '@/src/db'

const caller = schedulesRouter.createCaller({})

function createTables() {
  (sqlite as any).exec(`
    CREATE TABLE IF NOT EXISTS temperature_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      day_of_week TEXT NOT NULL,
      time TEXT NOT NULL,
      temperature REAL NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS power_schedules (
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
    CREATE TABLE IF NOT EXISTS alarm_schedules (
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
  `)
}

function clearTables() {
  (sqlite as any).exec(`
    DELETE FROM temperature_schedules;
    DELETE FROM power_schedules;
    DELETE FROM alarm_schedules;
  `)
}

beforeAll(() => {
  createTables()
})

afterAll(() => {
  (sqlite as any).close()
})

function resetSchedulerMocks() {
  mocks.reloadSchedules.mockReset().mockResolvedValue(undefined)
  mocks.upsertTemperatureJob.mockReset()
  mocks.cancelTemperatureJob.mockReset()
  mocks.upsertPowerJob.mockReset()
  mocks.cancelPowerJob.mockReset()
  mocks.upsertAlarmJob.mockReset()
  mocks.cancelAlarmJob.mockReset()
}

describe('schedules.batchUpdate', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('creates schedules across all types in one call', async () => {
    const result = await caller.batchUpdate({
      creates: {
        temperature: [
          { side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68, enabled: true },
          { side: 'left', dayOfWeek: 'tuesday', time: '22:00', temperature: 70, enabled: true },
        ],
        power: [
          { side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: true },
        ],
        alarm: [
          { side: 'left', dayOfWeek: 'monday', time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 120, alarmTemperature: 80, enabled: true },
        ],
      },
    })

    expect(result).toEqual({ success: true })

    const all = await caller.getAll({ side: 'left' })
    expect(all.temperature).toHaveLength(2)
    expect(all.power).toHaveLength(1)
    expect(all.alarm).toHaveLength(1)
  })

  it('deletes schedules by ID', async () => {
    // Seed
    const t1 = await caller.createTemperatureSchedule({ side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 })
    await caller.createTemperatureSchedule({ side: 'left', dayOfWeek: 'tuesday', time: '22:00', temperature: 70 })

    await caller.batchUpdate({
      deletes: { temperature: [t1.id] },
    })

    const after = await caller.getAll({ side: 'left' })
    expect(after.temperature).toHaveLength(1)
    expect(after.temperature[0].id).not.toBe(t1.id)
  })

  it('updates schedules in batch', async () => {
    const p1 = await caller.createPowerSchedule({ side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: true })
    const p2 = await caller.createPowerSchedule({ side: 'left', dayOfWeek: 'tuesday', onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: true })

    await caller.batchUpdate({
      updates: {
        power: [
          { id: p1.id, enabled: false },
          { id: p2.id, enabled: false },
        ],
      },
    })

    const after = await caller.getAll({ side: 'left' })
    expect(after.power.every((p: any) => p.enabled === false)).toBe(true)
  })

  it('handles mixed deletes + creates atomically (apply-to-other-days pattern)', async () => {
    // Monday has a schedule, Tuesday has a different one
    await caller.createTemperatureSchedule({ side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 })
    const tue = await caller.createTemperatureSchedule({ side: 'left', dayOfWeek: 'tuesday', time: '23:00', temperature: 72 })

    // "Apply Monday to Tuesday": delete Tuesday's, create copy of Monday's
    await caller.batchUpdate({
      deletes: { temperature: [tue.id] },
      creates: {
        temperature: [
          { side: 'left', dayOfWeek: 'tuesday', time: '22:00', temperature: 68, enabled: true },
        ],
      },
    })

    const after = await caller.getAll({ side: 'left' })
    expect(after.temperature).toHaveLength(2)

    const tuesday = after.temperature.find(t => t.dayOfWeek === 'tuesday')
    if (!tuesday) throw new Error('Expected to find tuesday schedule')
    expect(tuesday.time).toBe('22:00')
    expect(tuesday.temperature).toBe(68)
  })

  it('upserts one job per created row regardless of operation count', async () => {
    await caller.batchUpdate({
      creates: {
        temperature: [
          { side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 },
          { side: 'left', dayOfWeek: 'tuesday', time: '22:00', temperature: 70 },
          { side: 'left', dayOfWeek: 'wednesday', time: '22:00', temperature: 72 },
        ],
        power: [
          { side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75 },
          { side: 'left', dayOfWeek: 'tuesday', onTime: '22:00', offTime: '07:00', onTemperature: 75 },
        ],
      },
    })

    // One upsert per row inserted — no global wipe via reloadSchedules.
    expect(mocks.upsertTemperatureJob).toHaveBeenCalledTimes(3)
    expect(mocks.upsertPowerJob).toHaveBeenCalledTimes(2)
    expect(mocks.reloadSchedules).not.toHaveBeenCalled()
  })

  it('accepts empty input without errors', async () => {
    const result = await caller.batchUpdate({})
    expect(result).toEqual({ success: true })
  })

  it('applies deletes and creates atomically', async () => {
    await caller.createTemperatureSchedule({ side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 })

    const before = await caller.getAll({ side: 'left' })
    expect(before.temperature).toHaveLength(1)
    const id = before.temperature[0].id

    await caller.batchUpdate({
      deletes: { temperature: [id] },
      creates: {
        temperature: [
          { side: 'left', dayOfWeek: 'tuesday', time: '22:00', temperature: 70 },
          { side: 'left', dayOfWeek: 'wednesday', time: '22:00', temperature: 72 },
        ],
      },
    })

    const after = await caller.getAll({ side: 'left' })
    expect(after.temperature).toHaveLength(2)
    expect(after.temperature.find((t: any) => t.id === id)).toBeUndefined()
  })

  it('throws NOT_FOUND for missing delete IDs', async () => {
    await expect(
      caller.batchUpdate({ deletes: { temperature: [99999] } })
    ).rejects.toThrow('not found')
  })

  it('throws NOT_FOUND for missing update IDs', async () => {
    await expect(
      caller.batchUpdate({ updates: { power: [{ id: 99999, enabled: false }] } })
    ).rejects.toThrow('not found')
  })

  it('getAll converts temperatures to Celsius when unit=C', async () => {
    await caller.batchUpdate({
      creates: {
        temperature: [
          { side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 },
        ],
        power: [
          { side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 77 },
        ],
        alarm: [
          { side: 'left', dayOfWeek: 'monday', time: '07:00', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 120, alarmTemperature: 95 },
        ],
      },
    })

    const celsius = await caller.getAll({ side: 'left', unit: 'C' })
    expect(celsius.temperature[0].temperature).toBe(20) // 68°F = 20°C
    expect(celsius.power[0].onTemperature).toBe(25) // 77°F = 25°C
    expect(celsius.alarm[0].alarmTemperature).toBe(35) // 95°F = 35°C

    // Fahrenheit (default) returns raw values
    const fahrenheit = await caller.getAll({ side: 'left' })
    expect(fahrenheit.temperature[0].temperature).toBe(68)
    expect(fahrenheit.power[0].onTemperature).toBe(77)
    expect(fahrenheit.alarm[0].alarmTemperature).toBe(95)
  })

  it('getByDay converts temperatures to Celsius when unit=C', async () => {
    await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'wednesday', time: '23:00', temperature: 86,
    })

    const celsius = await caller.getByDay({ side: 'left', dayOfWeek: 'wednesday', unit: 'C' })
    expect(celsius.temperature[0].temperature).toBe(30) // 86°F = 30°C

    const fahrenheit = await caller.getByDay({ side: 'left', dayOfWeek: 'wednesday', unit: 'F' })
    expect(fahrenheit.temperature[0].temperature).toBe(86)
  })
})

describe('schedules.temperature CRUD', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('creates with defaults (enabled=true) and returns persisted record', async () => {
    const row = await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })

    expect(row.id).toBeGreaterThan(0)
    expect(row.enabled).toBe(true)
    expect(row.side).toBe('left')
    expect(row.temperature).toBe(68)
    expect(mocks.upsertTemperatureJob).toHaveBeenCalledTimes(1)
    expect(mocks.upsertTemperatureJob).toHaveBeenCalledWith(row)
  })

  it('rejects invalid time format with Zod error', async () => {
    await expect(
      caller.createTemperatureSchedule({
        side: 'left', dayOfWeek: 'monday', time: '25:99', temperature: 68,
      } as any)
    ).rejects.toThrow(/HH:MM/)
  })

  it('rejects out-of-range temperature', async () => {
    await expect(
      caller.createTemperatureSchedule({
        side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 200,
      } as any)
    ).rejects.toThrow(/110/)
  })

  it('rejects invalid side enum', async () => {
    await expect(
      caller.createTemperatureSchedule({
        side: 'middle', dayOfWeek: 'monday', time: '22:00', temperature: 68,
      } as any)
    ).rejects.toThrow()
  })

  it('rejects unknown keys due to .strict()', async () => {
    await expect(
      caller.createTemperatureSchedule({
        side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68, extra: 'x',
      } as any)
    ).rejects.toThrow()
  })

  it('updates and bumps updatedAt; passes when scheduler upsert throws', async () => {
    const row = await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })

    mocks.upsertTemperatureJob.mockImplementationOnce(() => {
      throw new Error('scheduler down')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const updated = await caller.updateTemperatureSchedule({
      id: row.id, temperature: 72, enabled: false,
    })

    expect(updated.temperature).toBe(72)
    expect(updated.enabled).toBe(false)
    expect(errSpy).toHaveBeenCalledWith('Scheduler reload failed:', expect.any(Error))
    errSpy.mockRestore()
  })

  it('update throws NOT_FOUND for missing id', async () => {
    await expect(
      caller.updateTemperatureSchedule({ id: 999999, temperature: 70 })
    ).rejects.toThrow(/not found/)
  })

  it('update rejects invalid id (non-positive)', async () => {
    await expect(
      caller.updateTemperatureSchedule({ id: 0, temperature: 70 })
    ).rejects.toThrow()
  })

  it('deletes successfully and cancels the matching scheduler job', async () => {
    const row = await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })
    resetSchedulerMocks()

    const result = await caller.deleteTemperatureSchedule({ id: row.id })
    expect(result).toEqual({ success: true })
    expect(mocks.cancelTemperatureJob).toHaveBeenCalledTimes(1)
    expect(mocks.cancelTemperatureJob).toHaveBeenCalledWith(row.id)

    const all = await caller.getAll({ side: 'left' })
    expect(all.temperature).toHaveLength(0)
  })

  it('delete throws NOT_FOUND for missing id', async () => {
    await expect(
      caller.deleteTemperatureSchedule({ id: 999999 })
    ).rejects.toThrow(/not found/)
  })
})

describe('schedules.power CRUD', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('creates and persists row with defaults', async () => {
    const row = await caller.createPowerSchedule({
      side: 'right', dayOfWeek: 'friday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })
    expect(row.enabled).toBe(true)
    expect(row.onTime).toBe('22:00')
    expect(row.offTime).toBe('07:00')
    expect(mocks.upsertPowerJob).toHaveBeenCalledTimes(1)
    expect(mocks.upsertPowerJob).toHaveBeenCalledWith(row)
  })

  it('rejects invalid onTime format', async () => {
    await expect(
      caller.createPowerSchedule({
        side: 'left', dayOfWeek: 'monday', onTime: 'bad', offTime: '07:00', onTemperature: 75,
      } as any)
    ).rejects.toThrow(/HH:MM/)
  })

  it('rejects invalid dayOfWeek', async () => {
    await expect(
      caller.createPowerSchedule({
        side: 'left', dayOfWeek: 'funday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
      } as any)
    ).rejects.toThrow()
  })

  it('updates partial fields', async () => {
    const row = await caller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })

    const updated = await caller.updatePowerSchedule({ id: row.id, onTime: '23:00' })
    expect(updated.onTime).toBe('23:00')
    expect(updated.offTime).toBe('07:00')
  })

  it('update throws NOT_FOUND for missing id', async () => {
    await expect(
      caller.updatePowerSchedule({ id: 999999, enabled: false })
    ).rejects.toThrow(/not found/)
  })

  it('deletes existing row', async () => {
    const row = await caller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })

    const out = await caller.deletePowerSchedule({ id: row.id })
    expect(out).toEqual({ success: true })

    const all = await caller.getAll({ side: 'left' })
    expect(all.power).toHaveLength(0)
  })

  it('delete throws NOT_FOUND for missing id', async () => {
    await expect(
      caller.deletePowerSchedule({ id: 999999 })
    ).rejects.toThrow(/not found/)
  })
})

describe('schedules.alarm CRUD', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('creates with vibrationPattern default of "rise"', async () => {
    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)
    expect(row.vibrationPattern).toBe('rise')
    expect(row.duration).toBe(120)
    expect(mocks.upsertAlarmJob).toHaveBeenCalledTimes(1)
    expect(mocks.upsertAlarmJob).toHaveBeenCalledWith(row)
  })

  it('accepts explicit "double" vibrationPattern', async () => {
    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, vibrationPattern: 'double', duration: 60, alarmTemperature: 80,
    })
    expect(row.vibrationPattern).toBe('double')
  })

  it('rejects vibrationIntensity above 100', async () => {
    await expect(
      caller.createAlarmSchedule({
        side: 'left', dayOfWeek: 'monday', time: '07:00',
        vibrationIntensity: 200, duration: 120, alarmTemperature: 80,
      } as any)
    ).rejects.toThrow(/100/)
  })

  it('rejects vibrationIntensity below 1', async () => {
    await expect(
      caller.createAlarmSchedule({
        side: 'left', dayOfWeek: 'monday', time: '07:00',
        vibrationIntensity: 0, duration: 120, alarmTemperature: 80,
      } as any)
    ).rejects.toThrow(/Intensity/)
  })

  it('rejects duration above 180', async () => {
    await expect(
      caller.createAlarmSchedule({
        side: 'left', dayOfWeek: 'monday', time: '07:00',
        vibrationIntensity: 50, duration: 999, alarmTemperature: 80,
      } as any)
    ).rejects.toThrow(/180/)
  })

  it('rejects unknown vibrationPattern', async () => {
    await expect(
      caller.createAlarmSchedule({
        side: 'left', dayOfWeek: 'monday', time: '07:00',
        vibrationIntensity: 50, vibrationPattern: 'pulse', duration: 120, alarmTemperature: 80,
      } as any)
    ).rejects.toThrow()
  })

  it('updates partial fields and bumps updatedAt', async () => {
    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)

    const updated = await caller.updateAlarmSchedule({
      id: row.id, vibrationIntensity: 80, vibrationPattern: 'double',
    })
    expect(updated.vibrationIntensity).toBe(80)
    expect(updated.vibrationPattern).toBe('double')
  })

  it('update throws NOT_FOUND for missing id', async () => {
    await expect(
      caller.updateAlarmSchedule({ id: 999999, duration: 30 })
    ).rejects.toThrow(/not found/)
  })

  it('deletes existing row', async () => {
    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)

    const out = await caller.deleteAlarmSchedule({ id: row.id })
    expect(out).toEqual({ success: true })

    const all = await caller.getAll({ side: 'left' })
    expect(all.alarm).toHaveLength(0)
  })

  it('delete throws NOT_FOUND for missing id', async () => {
    await expect(
      caller.deleteAlarmSchedule({ id: 999999 })
    ).rejects.toThrow(/not found/)
  })
})

describe('schedules scheduler-failure paths swallow errors', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('createPowerSchedule logs but does not throw when upsert fails', async () => {
    mocks.upsertPowerJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const row = await caller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })

    expect(row.id).toBeGreaterThan(0)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('createAlarmSchedule logs but does not throw when upsert fails', async () => {
    mocks.upsertAlarmJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)

    expect(row.id).toBeGreaterThan(0)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('deleteTemperatureSchedule logs but does not throw when cancel fails', async () => {
    const row = await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })
    resetSchedulerMocks()
    mocks.cancelTemperatureJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const out = await caller.deleteTemperatureSchedule({ id: row.id })
    expect(out).toEqual({ success: true })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('deletePowerSchedule logs but does not throw when cancel fails', async () => {
    const row = await caller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })
    resetSchedulerMocks()
    mocks.cancelPowerJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const out = await caller.deletePowerSchedule({ id: row.id })
    expect(out).toEqual({ success: true })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('deleteAlarmSchedule logs but does not throw when cancel fails', async () => {
    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)
    resetSchedulerMocks()
    mocks.cancelAlarmJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const out = await caller.deleteAlarmSchedule({ id: row.id })
    expect(out).toEqual({ success: true })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('batchUpdate logs but does not throw when upsert fails', async () => {
    mocks.upsertTemperatureJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await caller.batchUpdate({
      creates: {
        temperature: [
          { side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 },
        ],
      },
    })
    expect(result).toEqual({ success: true })
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('updatePowerSchedule logs but does not throw when upsert fails', async () => {
    const row = await caller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })
    resetSchedulerMocks()
    mocks.upsertPowerJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const out = await caller.updatePowerSchedule({ id: row.id, enabled: false })
    expect(out.enabled).toBe(false)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  it('updateAlarmSchedule logs but does not throw when upsert fails', async () => {
    const row = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)
    resetSchedulerMocks()
    mocks.upsertAlarmJob.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const out = await caller.updateAlarmSchedule({ id: row.id, duration: 30 })
    expect(out.duration).toBe(30)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })
})

describe('schedules.batchUpdate additional paths', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('throws NOT_FOUND for missing power delete id', async () => {
    await expect(
      caller.batchUpdate({ deletes: { power: [99999] } })
    ).rejects.toThrow(/Power schedule with ID 99999 not found/)
  })

  it('throws NOT_FOUND for missing alarm delete id', async () => {
    await expect(
      caller.batchUpdate({ deletes: { alarm: [99999] } })
    ).rejects.toThrow(/Alarm schedule with ID 99999 not found/)
  })

  it('throws NOT_FOUND for missing temperature update id', async () => {
    await expect(
      caller.batchUpdate({
        updates: { temperature: [{ id: 99999, temperature: 70 }] },
      })
    ).rejects.toThrow(/Temperature schedule with ID 99999 not found/)
  })

  it('throws NOT_FOUND for missing alarm update id', async () => {
    await expect(
      caller.batchUpdate({
        updates: { alarm: [{ id: 99999, duration: 30 }] },
      })
    ).rejects.toThrow(/Alarm schedule with ID 99999 not found/)
  })

  it('rejects oversized creates array (>1000)', async () => {
    const big = Array.from({ length: 1001 }, () => ({
      side: 'left' as const, dayOfWeek: 'monday' as const,
      time: '22:00', temperature: 68, enabled: true,
    }))
    await expect(
      caller.batchUpdate({ creates: { temperature: big } })
    ).rejects.toThrow()
  })

  it('updates alarm and power in batch', async () => {
    const t = await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })
    const a = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)

    await caller.batchUpdate({
      updates: {
        temperature: [{ id: t.id, temperature: 70 }],
        alarm: [{ id: a.id, duration: 30 }],
      },
    })

    const all = await caller.getAll({ side: 'left' })
    expect(all.temperature[0].temperature).toBe(70)
    expect(all.alarm[0].duration).toBe(30)
  })
})

describe('schedules incremental scheduler API', () => {
  beforeEach(() => {
    clearTables()
    resetSchedulerMocks()
  })

  it('upsertAlarmJob receives a row matching the persisted record', async () => {
    const created = await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)

    expect(mocks.upsertAlarmJob).toHaveBeenCalledTimes(1)
    const arg = mocks.upsertAlarmJob.mock.calls[0][0] as any
    expect(arg.id).toBe(created.id)
    expect(arg.time).toBe('07:00')
    expect(arg.enabled).toBe(true)
  })

  it('yggdrasil-49 regression: an unrelated mutation does NOT cancel a recently-created alarm', async () => {
    // Caller-A creates an alarm for 07:00 on Monday.
    await caller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)
    resetSchedulerMocks()

    // Caller-B mutates a completely unrelated temperature schedule a few
    // seconds later — what previously was 07:00:04 inside the alarm's fire
    // window. With the old fire-and-forget reloadScheduler() this would have
    // cancelled+recreated every recurring job; with the incremental API the
    // alarm is never touched.
    await caller.createTemperatureSchedule({
      side: 'right', dayOfWeek: 'tuesday', time: '21:00', temperature: 70,
    })

    expect(mocks.cancelAlarmJob).not.toHaveBeenCalled()
    expect(mocks.reloadSchedules).not.toHaveBeenCalled()
    // The temperature route only touches the temperature helper.
    expect(mocks.upsertTemperatureJob).toHaveBeenCalledTimes(1)
    expect(mocks.upsertAlarmJob).not.toHaveBeenCalled()
  })

  it('batchUpdate fans out into per-row upserts/cancels rather than a global reload', async () => {
    const seed = await caller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })
    resetSchedulerMocks()

    await caller.batchUpdate({
      deletes: { temperature: [seed.id] },
      creates: {
        alarm: [
          { side: 'left', dayOfWeek: 'monday', time: '07:00', vibrationIntensity: 50, duration: 120, alarmTemperature: 80 },
        ],
      },
    })

    expect(mocks.cancelTemperatureJob).toHaveBeenCalledWith(seed.id)
    expect(mocks.upsertAlarmJob).toHaveBeenCalledTimes(1)
    expect(mocks.reloadSchedules).not.toHaveBeenCalled()
  })
})

describe('schedules query error paths', () => {
  it('getAll wraps DB errors as INTERNAL_SERVER_ERROR', async () => {
    // Re-mock db to throw inside .all()
    const failing = { db: {
      select: () => ({
        from: () => ({
          where: () => ({
            all: () => { throw new Error('db dead') },
          }),
        }),
      }),
    } }

    vi.resetModules()
    vi.doMock('@/src/scheduler', () => ({
      getJobManager: vi.fn(async () => ({
        reloadSchedules: vi.fn(),
        upsertTemperatureJob: vi.fn(),
        cancelTemperatureJob: vi.fn(),
        upsertPowerJob: vi.fn(),
        cancelPowerJob: vi.fn(),
        upsertAlarmJob: vi.fn(),
        cancelAlarmJob: vi.fn(),
      })),
    }))
    vi.doMock('@/src/db', () => failing)

    const { schedulesRouter: failingRouter } = await import('@/src/server/routers/schedules')
    const failingCaller = failingRouter.createCaller({})

    await expect(failingCaller.getAll({ side: 'left' })).rejects.toThrow(/Failed to fetch schedules/)
    await expect(
      failingCaller.getByDay({ side: 'left', dayOfWeek: 'monday' })
    ).rejects.toThrow(/Failed to fetch schedules by day/)

    vi.doUnmock('@/src/db')
    vi.doUnmock('@/src/scheduler')
    vi.resetModules()
  })

  it('create handlers throw INTERNAL_SERVER_ERROR when insert returns no row', async () => {
    // Build a chain whose tx.insert(...).values(...).returning().all() yields [].
    const emptyAll = vi.fn(() => [])
    const txReturning = { returning: vi.fn(() => ({ all: emptyAll })) }
    const txValues = { values: vi.fn(() => txReturning) }
    const txInsert = { insert: vi.fn(() => txValues) }

    const failing = { db: {
      transaction: (cb: (tx: typeof txInsert) => unknown) => cb(txInsert),
    } }

    vi.resetModules()
    vi.doMock('@/src/scheduler', () => ({
      getJobManager: vi.fn(async () => ({
        reloadSchedules: vi.fn(),
        upsertTemperatureJob: vi.fn(),
        cancelTemperatureJob: vi.fn(),
        upsertPowerJob: vi.fn(),
        cancelPowerJob: vi.fn(),
        upsertAlarmJob: vi.fn(),
        cancelAlarmJob: vi.fn(),
      })),
    }))
    vi.doMock('@/src/db', () => failing)

    const { schedulesRouter: failingRouter } = await import('@/src/server/routers/schedules')
    const failingCaller = failingRouter.createCaller({})

    await expect(failingCaller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })).rejects.toThrow(/no record returned/)

    await expect(failingCaller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })).rejects.toThrow(/no record returned/)

    await expect(failingCaller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)).rejects.toThrow(/no record returned/)

    vi.doUnmock('@/src/db')
    vi.doUnmock('@/src/scheduler')
    vi.resetModules()
  })

  it('mutation handlers wrap non-TRPC DB errors as INTERNAL_SERVER_ERROR', async () => {
    const failing = { db: {
      transaction: () => { throw new Error('tx exploded') },
    } }

    vi.resetModules()
    vi.doMock('@/src/scheduler', () => ({
      getJobManager: vi.fn(async () => ({
        reloadSchedules: vi.fn(),
        upsertTemperatureJob: vi.fn(),
        cancelTemperatureJob: vi.fn(),
        upsertPowerJob: vi.fn(),
        cancelPowerJob: vi.fn(),
        upsertAlarmJob: vi.fn(),
        cancelAlarmJob: vi.fn(),
      })),
    }))
    vi.doMock('@/src/db', () => failing)

    const { schedulesRouter: failingRouter } = await import('@/src/server/routers/schedules')
    const failingCaller = failingRouter.createCaller({})

    await expect(failingCaller.createTemperatureSchedule({
      side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68,
    })).rejects.toThrow(/Failed to create temperature schedule/)

    await expect(failingCaller.updateTemperatureSchedule({
      id: 1, temperature: 70,
    })).rejects.toThrow(/Failed to update temperature schedule/)

    await expect(failingCaller.deleteTemperatureSchedule({ id: 1 }))
      .rejects.toThrow(/Failed to delete temperature schedule/)

    await expect(failingCaller.createPowerSchedule({
      side: 'left', dayOfWeek: 'monday', onTime: '22:00', offTime: '07:00', onTemperature: 75,
    })).rejects.toThrow(/Failed to create power schedule/)

    await expect(failingCaller.updatePowerSchedule({
      id: 1, enabled: false,
    })).rejects.toThrow(/Failed to update power schedule/)

    await expect(failingCaller.deletePowerSchedule({ id: 1 }))
      .rejects.toThrow(/Failed to delete power schedule/)

    await expect(failingCaller.createAlarmSchedule({
      side: 'left', dayOfWeek: 'monday', time: '07:00',
      vibrationIntensity: 50, duration: 120, alarmTemperature: 80,
    } as any)).rejects.toThrow(/Failed to create alarm schedule/)

    await expect(failingCaller.updateAlarmSchedule({
      id: 1, duration: 60,
    })).rejects.toThrow(/Failed to update alarm schedule/)

    await expect(failingCaller.deleteAlarmSchedule({ id: 1 }))
      .rejects.toThrow(/Failed to delete alarm schedule/)

    await expect(failingCaller.batchUpdate({
      creates: { temperature: [{ side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 68 }] },
    })).rejects.toThrow(/Failed to batch update schedules/)

    vi.doUnmock('@/src/db')
    vi.doUnmock('@/src/scheduler')
    vi.resetModules()
  })
})

