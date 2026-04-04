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

import { scheduleGroupsRouter } from '@/src/server/routers/scheduleGroups'
import { sqlite } from '@/src/db'

const caller = scheduleGroupsRouter.createCaller({})

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
    CREATE TABLE IF NOT EXISTS schedule_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      side TEXT NOT NULL,
      name TEXT NOT NULL,
      days TEXT NOT NULL,
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
    DELETE FROM schedule_groups;
  `)
}

describe('scheduleGroups', () => {
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

  it('creates a group', async () => {
    const result = await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday', 'wednesday'],
    })

    expect(result.name).toBe('Weekdays')
    expect(result.days).toEqual(['monday', 'tuesday', 'wednesday'])
    expect(result.side).toBe('left')
    expect(result.id).toBeGreaterThan(0)
  })

  it('rejects overlapping group with CONFLICT error', async () => {
    await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday', 'wednesday'],
    })

    await expect(
      caller.create({
        side: 'left',
        name: 'Early Week',
        days: ['monday', 'thursday'],
      })
    ).rejects.toThrow(/already belong to group/)
  })

  it('updates group days without conflict', async () => {
    const group = await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday'],
    })

    const updated = await caller.update({
      id: group.id,
      days: ['monday', 'tuesday', 'wednesday'],
    })

    expect(updated.days).toEqual(['monday', 'tuesday', 'wednesday'])
  })

  it('rejects update with conflicting days', async () => {
    await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday'],
    })

    const weekend = await caller.create({
      side: 'left',
      name: 'Weekend',
      days: ['saturday', 'sunday'],
    })

    await expect(
      caller.update({
        id: weekend.id,
        days: ['saturday', 'sunday', 'monday'],
      })
    ).rejects.toThrow(/already belong to group/)
  })

  it('deletes a group', async () => {
    const group = await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday'],
    })

    const result = await caller.delete({ id: group.id })
    expect(result).toEqual({ success: true })

    const all = await caller.getAll({ side: 'left' })
    expect(all).toHaveLength(0)
  })

  it('getByDay returns the correct group', async () => {
    await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday', 'wednesday'],
    })

    const result = await caller.getByDay({ side: 'left', dayOfWeek: 'tuesday' })
    expect(result).not.toBeNull()
    expect(result.name).toBe('Weekdays')
    expect(result.days).toContain('tuesday')
  })

  it('getByDay returns null for ungrouped day', async () => {
    await caller.create({
      side: 'left',
      name: 'Weekdays',
      days: ['monday', 'tuesday'],
    })

    const result = await caller.getByDay({ side: 'left', dayOfWeek: 'saturday' })
    expect(result).toBeNull()
  })
})
