/**
 * adoptUnmanagedSchedules against a real in-memory sleepypod.db with
 * migrations applied.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as schema from '@/src/db/schema'
import type { DayOfWeek } from '@/src/lib/scheduleTime'

vi.mock('@/src/scheduler', () => ({ getJobManager: vi.fn() }))

const { adoptUnmanagedSchedules } = await import('@/src/server/scheduleLibrary')

type Side = 'left' | 'right'

describe('adoptUnmanagedSchedules', () => {
  let raw: Database.Database
  let db: ReturnType<typeof drizzle<typeof schema>>

  beforeEach(() => {
    raw = new Database(':memory:')
    db = drizzle(raw, { schema })
    migrate(db, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
    db.insert(schema.sideSettings).values([{ side: 'left', name: 'Jo' }, { side: 'right', name: 'Sam' }]).run()
  })

  afterEach(() => raw.close())

  const adopt = () => db.transaction(tx => adoptUnmanagedSchedules(tx))

  function night(side: Side, days: DayOfWeek[], points: Record<string, number>, endAction: 'turn_off' | 'maintain' = 'turn_off', enabled = true) {
    for (const dayOfWeek of days) {
      for (const [time, temperature] of Object.entries(points)) {
        db.insert(schema.temperatureSchedules).values({ side, dayOfWeek, time, temperature, enabled }).run()
      }
      const times = Object.keys(points)
      db.insert(schema.powerSchedules).values({ side, dayOfWeek, onTime: times[0], offTime: times[times.length - 1], onTemperature: 70, endAction, enabled }).run()
    }
  }

  const curves = () => db.select().from(schema.curveTemplates).all()
    .map(c => ({ name: c.name, active: c.active, left: c.leftDays, right: c.rightDays, points: c.points, endAction: c.endAction, notes: c.notes, bedtime: c.bedtime, wake: c.wake }))
  const rowCounts = () => ({
    temperature: db.select().from(schema.temperatureSchedules).all().length,
    power: db.select().from(schema.powerSchedules).all().length,
  })

  const WEEK = { '22:00': 70, '02:00': 66, '06:30': 78 }
  const WEEKEND = { '23:00': 72, '08:00': 80 }

  it('returns 0 and adds nothing without schedules', () => {
    expect(adopt()).toBe(0)
    expect(curves()).toEqual([])
  })

  it('makes one active curve per side for days with the same set points and end action, without touching rows', () => {
    night('left', ['monday', 'tuesday', 'wednesday'], WEEK)
    night('left', ['saturday', 'sunday'], WEEKEND)
    night('left', ['friday'], WEEKEND, 'maintain')
    db.insert(schema.scheduleNotes).values({ side: 'left', dayOfWeek: 'tuesday', notes: 'Cool start' }).run()
    const before = rowCounts()

    expect(adopt()).toBe(3)
    expect(rowCounts()).toEqual(before)
    const list = curves()
    expect(list).toHaveLength(3)
    expect(list.find(c => c.left.includes('monday'))).toEqual({
      name: 'Jo Mon–Wed', active: true, left: ['monday', 'tuesday', 'wednesday'], right: [],
      points: WEEK, endAction: 'turn_off', notes: 'Cool start', bedtime: '22:00', wake: '06:30',
    })
    expect(list.find(c => c.left.includes('sunday'))).toMatchObject({ name: 'Jo Sat, Sun', left: ['sunday', 'saturday'], endAction: 'turn_off', notes: '' })
    expect(list.find(c => c.left.includes('friday'))).toMatchObject({ name: 'Jo Fri', endAction: 'maintain' })
  })

  it('merges matching sides into one curve and names a lone side curve after the sleeper', () => {
    night('left', ['monday', 'tuesday'], WEEK)
    night('right', ['monday', 'friday'], WEEK)
    night('right', ['sunday'], WEEKEND, 'turn_off', false)

    expect(adopt()).toBe(2)
    expect(curves()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Both sides schedule', active: true, left: ['monday', 'tuesday'], right: ['monday', 'friday'] }),
      // Paused rows are adopted too; the curve is on and the rows keep their enabled flag.
      expect.objectContaining({ name: 'Sam schedule', active: true, left: [], right: ['sunday'] }),
    ]))
  })

  it('reuses a saved curve with no days and the same set points and end action', () => {
    const at = new Date()
    db.insert(schema.curveTemplates).values([
      { name: 'Late Warm', bedtime: '22:00', wake: '06:30', points: WEEK, endAction: 'maintain', createdAt: at, updatedAt: at },
      { name: 'Weeknight', bedtime: '22:00', wake: '06:30', points: WEEK, createdAt: at, updatedAt: at },
    ]).run()
    night('left', ['monday'], WEEK)

    expect(adopt()).toBe(1)
    const list = curves()
    expect(list).toHaveLength(2)
    expect(list.find(c => c.name === 'Weeknight')).toMatchObject({ active: true, left: ['monday'], right: [] })
    expect(list.find(c => c.name === 'Late Warm')).toMatchObject({ active: false, left: [], right: [] })
  })

  it('skips days an active curve already runs, but not days of a curve that is off', () => {
    const at = new Date()
    db.insert(schema.curveTemplates).values([
      { name: 'On', bedtime: '22:00', wake: '06:30', points: WEEK, leftDays: ['monday'], active: true, createdAt: at, updatedAt: at },
      { name: 'Off', bedtime: '22:00', wake: '06:30', points: WEEKEND, leftDays: ['tuesday'], active: false, createdAt: at, updatedAt: at },
    ]).run()
    night('left', ['monday', 'tuesday'], WEEK)

    expect(adopt()).toBe(1)
    expect(curves().find(c => c.name === 'Jo schedule')).toMatchObject({ left: ['tuesday'], active: true })
    // Running it again finds nothing left to adopt.
    expect(adopt()).toBe(0)
  })

  it('keeps names unique and within 30 characters', () => {
    db.update(schema.sideSettings).set({ name: 'Bartholomew-Alexandria Smith' }).where(eq(schema.sideSettings.side, 'left')).run()
    const at = new Date()
    db.insert(schema.curveTemplates).values({ name: 'Bartholomew-Alexandria Smith s', bedtime: '22:00', wake: '06:30', points: WEEKEND, leftDays: ['friday'], active: false, createdAt: at, updatedAt: at }).run()
    night('left', ['monday'], WEEK)
    night('right', ['tuesday'], WEEKEND)

    expect(adopt()).toBe(2)
    const names = curves().map(c => c.name)
    expect(names.every(n => n.length <= 30)).toBe(true)
    expect(new Set(names).size).toBe(names.length)
    expect(names.sort()).toEqual(['Bartholomew-Alexandria Smith 2', 'Bartholomew-Alexandria Smith s', 'Sam schedule'])
  })
})
