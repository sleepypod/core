/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

// Hoist mocks so they're available to vi.mock factories
const mocks = vi.hoisted(() => ({
  reloadSchedules: vi.fn(),
}))

vi.mock('@/src/scheduler', () => ({
  getJobManager: vi.fn(async () => ({
    reloadSchedules: mocks.reloadSchedules,
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

describe('schedules.batchUpdate', () => {
  beforeAll(() => {
    createTables()
  })

  beforeEach(() => {
    clearTables()
    mocks.reloadSchedules.mockClear()
  })

  afterAll(() => {
    (sqlite as any).close()
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

    const tuesday = after.temperature.find((t: any) => t.dayOfWeek === 'tuesday')
    expect(tuesday.time).toBe('22:00')
    expect(tuesday.temperature).toBe(68)
  })

  it('calls reloadScheduler exactly once regardless of operation count', async () => {
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

    expect(mocks.reloadSchedules).toHaveBeenCalledTimes(1)
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

