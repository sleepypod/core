import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { eq } from 'drizzle-orm'
const base = vi.hoisted(() => ({ setPosition: vi.fn() }))
vi.mock('@/src/hardware/base/instance', () => ({ getBaseController: () => base }))
vi.mock('@/src/temperature/instance', () => ({ getTemperatureController: vi.fn() }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getSharedHardwareClient: vi.fn() }))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({ broadcastMutationStatus: vi.fn() }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: () => false }))
vi.mock('@/src/services/autoOffWatcher', () => ({ cancelAutoOffTimer: vi.fn() }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
import { db, sqlite } from '@/src/db'
import { baseSchedules, sideSettings } from '@/src/db/schema'
import { JobManager } from '../jobManager'
import { Scheduler } from '../scheduler'
import { JobType } from '../types'
import * as nodeSchedule from 'node-schedule'
vi.mock('node-schedule', { spy: true })

let manager: JobManager
const values = { dayOfWeek: 'monday' as const, time: '22:30', head: 30, feet: 15, feedRate: 50, enabled: true }
beforeAll(() => migrate(db, { migrationsFolder: 'src/db/migrations' }))
beforeEach(() => {
  vi.clearAllMocks()
  db.delete(baseSchedules).run()
  db.delete(sideSettings).run()
  db.insert(sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).run()
  manager = new JobManager('Europe/Berlin', { heartbeatIntervalMs: 0 })
})
afterEach(async () => {
  await manager.shutdown()
})
afterAll(() => sqlite.close())

describe('whole-bed elevation scheduling', () => {
  it('registers exactly one weekly job in the device timezone, then removes it when paused', () => {
    const register = vi.mocked(nodeSchedule.scheduleJob)
    const cancel = vi.spyOn(Scheduler.prototype, 'cancelJob')
    const row = db.insert(baseSchedules).values(values).returning().get()
    manager.upsertBaseSchedule(row)
    expect(register).toHaveBeenCalledWith({ tz: 'Europe/Berlin', rule: '30 22 * * 1' }, expect.any(Function))
    manager.upsertBaseSchedule({ ...row, enabled: false })
    expect(cancel).toHaveBeenCalledWith(`base-${row.id}`)
    cancel.mockRestore()
  })
  it('checks either side away and rechecks edits/deletion inside the controller lock', async () => {
    const row = db.insert(baseSchedules).values(values).returning().get()
    base.setPosition.mockImplementation(async (_position, guard: () => Promise<boolean>) => {
      expect(await guard()).toBe(true)
      db.update(sideSettings).set({ awayMode: true }).where(eq(sideSettings.side, 'right')).run()
      expect(await guard()).toBe(false)
      db.update(sideSettings).set({ awayMode: false }).run()
      db.update(baseSchedules).set({ head: 20 }).where(eq(baseSchedules.id, row.id)).run()
      expect(await guard()).toBe(false)
      db.delete(baseSchedules).run()
      expect(await guard()).toBe(false)
    })
    await manager.runBaseJob(row.id)
    expect(base.setPosition).toHaveBeenCalledTimes(1)
  })
  it.each([['daily', '0,1,2,3,4,5,6'], ['weekdays', '1,2,3,4,5'], ['weekends', '0,6']] as const)('registers %s in the device timezone', (dayOfWeek, days) => {
    const row = db.insert(baseSchedules).values({ ...values, dayOfWeek }).returning().get()
    manager.upsertBaseSchedule(row)
    expect(nodeSchedule.scheduleJob).toHaveBeenCalledWith({ tz: 'Europe/Berlin', rule: `30 22 * * ${days}` }, expect.any(Function))
  })
  it.each(['left', 'right'] as const)('checks only the %s side away mode and rechecks scope inside the lock', async (side) => {
    const other = side === 'left' ? 'right' : 'left'
    const row = db.insert(baseSchedules).values({ ...values, side }).returning().get()
    db.update(sideSettings).set({ awayMode: true }).where(eq(sideSettings.side, other)).run()
    base.setPosition.mockImplementation(async (position, guard: () => Promise<boolean>) => {
      expect(position.sides).toEqual([side])
      expect(await guard()).toBe(true)
      db.update(sideSettings).set({ awayMode: true }).where(eq(sideSettings.side, side)).run()
      expect(await guard()).toBe(false)
      db.update(sideSettings).set({ awayMode: false }).run()
      db.update(baseSchedules).set({ side: other }).where(eq(baseSchedules.id, row.id)).run()
      expect(await guard()).toBe(false)
    })
    await manager.runBaseJob(row.id)
    expect(base.setPosition).toHaveBeenCalledOnce()
  })
  it('skips a missed base invocation after suspend instead of catching up', async () => {
    const row = db.insert(baseSchedules).values(values).returning().get()
    manager.upsertBaseSchedule(row)
    const callback = vi.mocked(nodeSchedule.scheduleJob).mock.calls.at(-1)?.[1] as (date: Date) => Promise<void>
    await callback(new Date(Date.now() - 61_000))
    expect(base.setPosition).not.toHaveBeenCalled()
  })
  it('skips a move that waited too long for a hardware lock', async () => {
    const row = db.insert(baseSchedules).values(values).returning().get()
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
    base.setPosition.mockImplementation(async (_position, guard: () => Promise<boolean>) => {
      clock.mockReturnValue(now + 61_000)
      expect(await guard()).toBe(false)
    })
    try {
      await manager.runBaseJob(row.id)
    }
    finally {
      clock.mockRestore()
    }
  })
  it('does not send disabled or deleted schedules', async () => {
    const row = db.insert(baseSchedules).values({ ...values, enabled: false }).returning().get()
    await manager.runBaseJob(row.id)
    await manager.runBaseJob(row.id + 1)
    expect(base.setPosition).not.toHaveBeenCalled()
  })
  it('does not retry a failed physical movement', async () => {
    const scheduler = new Scheduler({ timezone: 'Europe/Berlin', enabled: true })
    const handler = vi.fn().mockRejectedValue(new Error('Bluetooth disconnected'))
    // Same execution path as a cron callback; BASE must stay outside the
    // retryable temperature/power job set.
    const executed = vi.fn()
    scheduler.on('jobExecuted', executed)
    scheduler.scheduleJob('base-test', JobType.BASE, '30 22 * * 1', handler)
    const callback = vi.mocked(nodeSchedule.scheduleJob).mock.calls.at(-1)?.[1] as () => Promise<void>
    await callback()
    expect(executed).toHaveBeenCalledWith('base-test', expect.objectContaining({ success: false }))
    expect(handler).toHaveBeenCalledOnce()
    await scheduler.shutdown()
  })
})
