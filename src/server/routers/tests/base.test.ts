import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { BaseError } from '@/src/hardware/base/types'
const availability = vi.hoisted(() => ({ configured: false }))
vi.mock('@/src/hardware/base/configuration', () => ({ isBaseConfigured: async () => availability.configured }))
const hardware = vi.hoisted(() => ({ status: vi.fn(), setPosition: vi.fn(), stop: vi.fn(), reconnect: vi.fn() }))
const scheduler = vi.hoisted(() => ({ upsertBaseSchedule: vi.fn(), removeBaseSchedule: vi.fn() }))
vi.mock('@/src/hardware/base/instance', () => ({ getBaseController: () => hardware }))
vi.mock('@/src/scheduler', () => ({ getJobManager: async () => scheduler }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
import { db, sqlite } from '@/src/db'
import { baseRouter } from '../base'
const caller = baseRouter.createCaller({})
const schedule = { head: 30, feet: 15, dayOfWeek: 'monday' as const, time: '22:00', enabled: true }
beforeAll(() => migrate(db, { migrationsFolder: 'src/db/migrations' }))
beforeEach(() => {
  vi.resetAllMocks()
  hardware.status.mockReturnValue({ independentControl: true })
  sqlite.exec('DELETE FROM base_schedules')
})
afterAll(() => sqlite.close())

describe('base API', () => {
  it('reports configuration availability without initializing the controller', async () => {
    availability.configured = false
    expect(await caller.getAvailability({})).toEqual({ configured: false })
    availability.configured = true
    expect(await caller.getAvailability({})).toEqual({ configured: true })
    expect(hardware.status).not.toHaveBeenCalled()
    expect(hardware.reconnect).not.toHaveBeenCalled()
  })
  it('validates positions and defaults the speed before hardware', async () => {
    await caller.setPosition({ head: 20, feet: 15 })
    expect(hardware.setPosition).toHaveBeenCalledWith({ head: 20, feet: 15, feedRate: 50, sides: ['left', 'right'] })
    await expect(caller.setPosition({ head: 61, feet: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.setPosition({ head: 20.5, feet: 0 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.setPosition({ head: 0, feet: 46 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.setPosition({ head: 0, feet: 0, feedRate: 101 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(hardware.setPosition).toHaveBeenCalledTimes(1)
  })
  it('only accepts defined presets including the real relax angles', async () => {
    await caller.setPreset({ preset: 'relax' })
    expect(hardware.setPosition).toHaveBeenCalledWith({ head: 30, feet: 15, feedRate: 50, sides: ['left', 'right'] })
    await expect(caller.setPreset({ preset: '__proto__' as 'flat' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('passes a validated side scope and rejects empty or duplicate sides', async () => {
    await caller.setPosition({ head: 10, feet: 5, sides: ['right'], feedRate: 75 })
    expect(hardware.setPosition).toHaveBeenCalledWith({ head: 10, feet: 5, sides: ['right'], feedRate: 75 })
    await expect(caller.setPosition({ head: 0, feet: 0, sides: [] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.setPosition({ head: 0, feet: 0, sides: ['left', 'left'] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('persists side and recurrence, allows independent concurrent slots and rejects overlaps', async () => {
    const row = await caller.saveSchedule({ ...schedule, dayOfWeek: 'weekdays', side: 'left', presetName: 'Relax' })
    expect(row).toMatchObject({ side: 'left', dayOfWeek: 'weekdays', presetName: 'Relax' })
    await caller.saveSchedule({ ...schedule, side: 'right' })
    await expect(caller.saveSchedule({ ...schedule, side: 'left' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(caller.saveSchedule({ ...schedule, dayOfWeek: 'daily', side: 'both' })).rejects.toMatchObject({ code: 'CONFLICT' })
    await caller.saveSchedule({ ...schedule, dayOfWeek: 'weekends', side: 'left' })
  })
  it('refuses per-side schedules when the transport cannot honor them', async () => {
    hardware.status.mockReturnValue({ independentControl: false })
    await expect(caller.saveSchedule({ ...schedule, side: 'left' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(await caller.getSchedules({})).toEqual([])
  })
  it('reports hardware failure and contention rather than success', async () => {
    hardware.stop.mockRejectedValueOnce(new BaseError('unavailable', 'Disconnected'))
    await expect(caller.stop({})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'Disconnected' })
    hardware.setPosition.mockRejectedValueOnce(new BaseError('busy', 'Busy'))
    await expect(caller.setPreset({ preset: 'flat' })).rejects.toMatchObject({ code: 'CONFLICT' })
    hardware.stop.mockRejectedValueOnce(new Error('private internal details'))
    await expect(caller.stop({})).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Base command failed' })
  })
  it('persists, updates, pauses, and deletes whole-bed schedules', async () => {
    const row = await caller.saveSchedule(schedule)
    expect(row.feedRate).toBe(50)
    expect(scheduler.upsertBaseSchedule).toHaveBeenCalledWith(row)
    expect(await caller.getSchedules({})).toEqual([row])
    await caller.saveSchedule({ ...row, enabled: false })
    expect((await caller.getSchedules({}))[0].enabled).toBe(false)
    await caller.deleteSchedule({ id: row.id })
    expect(await caller.getSchedules({})).toEqual([])
    expect(scheduler.removeBaseSchedule).toHaveBeenCalledWith(row.id)
    await expect(caller.saveSchedule({ ...row, enabled: true })).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
  it('rejects duplicate times and invalid schedule inputs', async () => {
    await caller.saveSchedule(schedule)
    await expect(caller.saveSchedule(schedule)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(caller.saveSchedule({ ...schedule, time: '24:00' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(caller.saveSchedule({ ...schedule, feet: -1 })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
