/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  upsertTemperatureJob: vi.fn(),
  cancelTemperatureJob: vi.fn(),
  upsertPowerJob: vi.fn(),
  cancelPowerJob: vi.fn(),
  upsertAlarmJob: vi.fn(),
  cancelAlarmJob: vi.fn(),
}))

vi.mock('@/src/scheduler', () => ({
  getJobManager: vi.fn(async () => mocks),
}))

vi.mock('@/src/db', async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new BetterSqlite3(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})

import { schedulesRouter } from '@/src/server/routers/schedules'
import { sqlite } from '@/src/db'

const caller = schedulesRouter.createCaller({})

// Monday 2026-09-28 14:00 UTC — tonight is Monday's schedule in the pod's UTC timezone.
const MON_14_UTC = new Date('2026-09-28T14:00:00Z')

beforeAll(() => {
  (sqlite as any).exec(`
    CREATE TABLE device_settings (id INTEGER PRIMARY KEY, timezone TEXT NOT NULL);
    INSERT INTO device_settings (id, timezone) VALUES (1, 'UTC');
    CREATE TABLE temperature_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, day_of_week TEXT NOT NULL, time TEXT NOT NULL,
      temperature REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE power_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, day_of_week TEXT NOT NULL, on_time TEXT NOT NULL,
      off_time TEXT NOT NULL, on_temperature REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE alarm_schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, side TEXT NOT NULL, day_of_week TEXT NOT NULL, time TEXT NOT NULL,
      vibration_intensity INTEGER NOT NULL, vibration_pattern TEXT NOT NULL DEFAULT 'rise', duration INTEGER NOT NULL,
      alarm_temperature REAL NOT NULL, wake_window INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `)
})

afterAll(() => {
  (sqlite as any).close()
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(MON_14_UTC)
  for (const fn of Object.values(mocks)) fn.mockReset()
  ;(sqlite as any).exec('DELETE FROM temperature_schedules; DELETE FROM power_schedules; DELETE FROM alarm_schedules;')
})

afterEach(() => {
  vi.useRealTimers()
})

type Day = 'monday' | 'tuesday' | 'wednesday'

async function curve(day: Day, temps = [76, 72, 74, 84], side: 'left' | 'right' = 'left') {
  const times = ['22:00', '23:00', '03:00', '06:00']
  await caller.batchUpdate({
    creates: { temperature: times.map((time, i) => ({ side, dayOfWeek: day, time, temperature: temps[i] })) },
  })
}

function temps(day: Day, side: 'left' | 'right' = 'left'): Record<string, number> {
  const rows = (sqlite as any).prepare(
    'SELECT time, temperature FROM temperature_schedules WHERE side = ? AND day_of_week = ? AND enabled = 1',
  ).all(side, day) as { time: string, temperature: number }[]
  return Object.fromEntries(rows.map(r => [r.time, r.temperature]))
}

describe('schedules.getNightPhases', () => {
  it('splits tonight into Night and Dawn from the pod-timezone day', async () => {
    await curve('monday')
    const phases = await caller.getNightPhases({ side: 'left' })
    expect(phases).toMatchObject({ draft: false, day: 'monday', days: ['monday'] })
    expect(phases?.night.times).toEqual(['22:00', '23:00', '03:00'])
    expect(phases?.dawn?.times).toEqual(['06:00'])
    expect(Math.round(phases?.night.temperatureF ?? Number.NaN)).toBe(73)
  })

  it('previews the balanced template as a draft when tonight has no schedule', async () => {
    const phases = await caller.getNightPhases({ side: 'left' })
    expect(phases?.draft).toBe(true)
    expect(phases?.day).toBe('monday')
    expect(phases?.dawn).not.toBeNull()
    expect(temps('monday')).toEqual({})
  })
})

describe('schedules.setNightPhase', () => {
  it('shifts the phase on every day sharing tonight’s curve and keeps its shape', async () => {
    await curve('monday')
    await curve('tuesday')
    await curve('wednesday', [70, 70, 70, 80])
    mocks.upsertTemperatureJob.mockClear()

    const phases = await caller.setNightPhase({ side: 'left', phase: 'night', temperature: 70 })

    expect(temps('monday')).toEqual({ '22:00': 73, '23:00': 69, '03:00': 71, '06:00': 84 })
    expect(temps('tuesday')).toEqual(temps('monday'))
    expect(temps('wednesday')).toEqual({ '22:00': 70, '23:00': 70, '03:00': 70, '06:00': 80 })
    expect(phases?.days).toEqual(['monday', 'tuesday'])
    expect(Math.round(phases?.night.temperatureF ?? Number.NaN)).toBe(70)
    expect(mocks.upsertTemperatureJob).toHaveBeenCalledTimes(6)
  })

  it('writes the template with the chosen value to every night without a schedule', async () => {
    await curve('wednesday', [70, 70, 70, 80])

    const phases = await caller.setNightPhase({ side: 'left', phase: 'dawn', temperature: 86 })

    expect(phases?.draft).toBe(false)
    expect(Math.round(phases?.dawn?.temperatureF ?? Number.NaN)).toBe(86)
    expect(Object.keys(temps('monday')).length).toBeGreaterThan(1)
    expect(temps('wednesday')).toEqual({ '22:00': 70, '23:00': 70, '03:00': 70, '06:00': 80 })
    const power = (sqlite as any).prepare('SELECT day_of_week FROM power_schedules WHERE side = ?').all('left')
    expect(power).toHaveLength(6)
  })

  it('leaves the other side alone', async () => {
    await curve('monday')
    await curve('monday', [80, 80, 80, 80], 'right')
    await caller.setNightPhase({ side: 'left', phase: 'night', temperature: 68 })
    expect(temps('monday', 'right')).toEqual({ '22:00': 80, '23:00': 80, '03:00': 80, '06:00': 80 })
  })

  it('rejects Dawn when tonight has a single set point', async () => {
    await caller.batchUpdate({ creates: { temperature: [{ side: 'left', dayOfWeek: 'monday', time: '22:00', temperature: 75 }] } })
    await expect(caller.setNightPhase({ side: 'left', phase: 'dawn', temperature: 80 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
