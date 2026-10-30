import assert from 'node:assert/strict'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import type { BedtimeDraft } from '@/src/lib/bedtimeRoutines'

const jobs = vi.hoisted(() => ({
  upsertTemperatureJob: vi.fn(), cancelTemperatureJob: vi.fn(),
  upsertPowerJob: vi.fn(), cancelPowerJob: vi.fn(),
  upsertAlarmJob: vi.fn(), cancelAlarmJob: vi.fn(),
}))
vi.mock('@/src/scheduler', () => ({ getJobManager: vi.fn(async () => jobs) }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { db: drizzle(sqlite, { schema }), sqlite }
})
import { db, sqlite } from '@/src/db'
import { getJobManager } from '@/src/scheduler'
import { routinesRouter } from '../routines'
import { schedulesRouter } from '../schedules'
import { alarmSchedules, powerSchedules, temperatureSchedules } from '@/src/db/schema'

const caller = routinesRouter.createCaller({})
const calendar = schedulesRouter.createCaller({})
const draft = {
  power: { onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: false, endAction: 'turn_off' },
  temperatures: [{ time: '01:00', temperature: 72, enabled: true }],
  alarm: { time: '06:30', vibrationPattern: 'rise', vibrationIntensity: 50, duration: 30, alarmTemperature: 80, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, enabled: true },
  notes: 'Weekend',
} satisfies BedtimeDraft
beforeAll(() => migrate(db, { migrationsFolder: './src/db/migrations' }))
beforeEach(() => {
  sqlite.exec('DELETE FROM bedtime_routines; DELETE FROM temperature_schedules; DELETE FROM power_schedules; DELETE FROM alarm_schedules;')
  vi.clearAllMocks()
})
afterAll(() => sqlite.close())

describe('bedtime routine contract', () => {
  it('keeps custom snooze settings through an atomic overnight move', async () => {
    const custom = { ...draft, alarm: { ...draft.alarm, snoozeDuration: 540, snoozeTaper: 40 as const } }
    const saved = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: custom }] })
    const moved = await caller.replace({ side: 'left', changes: [
      { dayOfWeek: 'saturday', expectedRevision: saved.routines[0].revision, replacement: null },
      { dayOfWeek: 'monday', expectedRevision: null, replacement: custom },
    ] })
    expect(moved.routines[0].draft.alarm).toMatchObject({ snoozeDuration: 540, snoozeTaper: 40 })
    expect(db.select().from(alarmSchedules).get()).toMatchObject({ dayOfWeek: 'tuesday', snoozeDuration: 540, snoozeTaper: 40 })
    expect(jobs.upsertAlarmJob).toHaveBeenLastCalledWith(expect.objectContaining({ snoozeDuration: 540, snoozeTaper: 40 }))
  })

  it('rejects older-client edits and moves that would discard custom snooze settings', async () => {
    const custom = { ...draft, alarm: { ...draft.alarm, snoozeDuration: 540, snoozeTaper: 30 as const } }
    const saved = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: custom }] })
    const legacy = { ...draft, alarm: { ...draft.alarm, snoozeDuration: undefined, snoozeTaper: undefined } }
    for (const changes of [
      [{ dayOfWeek: 'saturday' as const, expectedRevision: saved.routines[0].revision, replacement: legacy }],
      [{ dayOfWeek: 'saturday' as const, expectedRevision: saved.routines[0].revision, replacement: null }, { dayOfWeek: 'monday' as const, expectedRevision: null, replacement: legacy }],
    ]) {
      await expect(caller.replace({ side: 'left', changes })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
      expect((await caller.get({ side: 'left' })).routines).toEqual(saved.routines)
    }
  })

  it('accepts default-only older clients without silently changing snooze behavior', async () => {
    const legacy = { ...draft, alarm: { ...draft.alarm, snoozeDuration: undefined, snoozeTaper: undefined } }
    const created = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: legacy }] })
    const updated = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: created.routines[0].revision, replacement: { ...legacy, notes: 'Older client edit' } }] })
    expect(updated.routines[0].draft.alarm).toMatchObject({ snoozeDuration: 300, snoozeTaper: 0 })
  })

  it.each([{ snoozeDuration: 30 }, { snoozeDuration: 1801 }, { snoozeTaper: 20 }, { snoozeTaper: 70 }])('rejects invalid bedtime snooze settings %j', async (snooze) => {
    await expect(caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: { ...draft, alarm: { ...draft.alarm, ...snooze } } }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(db.select().from(alarmSchedules).all()).toEqual([])
  })
  it('round-trips a Saturday night with Sunday morning events and independent power times', async () => {
    const result = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] })
    expect(result.schedulerApplied).toBe(true)
    expect(result.routines[0].draft).toEqual(draft)
    expect(db.select().from(powerSchedules).all()).toEqual([expect.objectContaining({ dayOfWeek: 'saturday', offDayOffset: 1, onTime: '22:00', offTime: '07:00', enabled: false })])
    expect(db.select().from(temperatureSchedules).all()).toEqual([expect.objectContaining({ dayOfWeek: 'sunday', time: '01:00', enabled: false })])
    expect(db.select().from(alarmSchedules).all()).toEqual([expect.objectContaining({ dayOfWeek: 'sunday', time: '06:30', enabled: false })])
    expect(await caller.get({ side: 'left' })).toMatchObject({ routines: result.routines })
    expect(await caller.get({ side: 'right' })).toMatchObject({ routines: [], canCreate: true })
  })

  it('keeps a power-only routine visible and preserves its window after editing', async () => {
    const powerOnly = { ...draft, temperatures: [], alarm: null }
    const first = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'friday', expectedRevision: null, replacement: powerOnly }] })
    const saved = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'friday', expectedRevision: first.routines[0].revision, replacement: { ...powerOnly, notes: 'Updated' } }] })
    expect(saved.routines[0].draft.power).toEqual(powerOnly.power)
    expect(saved.routines[0].draft.temperatures).toEqual([])
    expect(db.select().from(temperatureSchedules).all()).toEqual([])
  })

  it('moves power, phases and alarm together without changing the other side', async () => {
    const first = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] })
    const right = await caller.replace({ side: 'right', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] })
    await caller.replace({ side: 'left', changes: [
      { dayOfWeek: 'saturday', expectedRevision: first.routines[0].revision, replacement: null },
      { dayOfWeek: 'monday', expectedRevision: null, replacement: draft },
    ] })
    const rows = await calendar.getAll({ side: 'left' })
    expect(rows.power.map(row => row.dayOfWeek)).toEqual(['monday'])
    expect(rows.temperature.map(row => row.dayOfWeek)).toEqual(['tuesday'])
    expect(rows.alarm.map(row => row.dayOfWeek)).toEqual(['tuesday'])
    expect((await caller.get({ side: 'right' })).routines).toEqual(right.routines)
  })

  it('rejects every write when one original revision is stale', async () => {
    const first = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })
    const current = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: first.routines[0].revision, replacement: { ...draft, notes: 'Other client' } }] })
    vi.clearAllMocks()
    await expect(caller.replace({ side: 'left', changes: [
      { dayOfWeek: 'tuesday', expectedRevision: null, replacement: draft },
      { dayOfWeek: 'monday', expectedRevision: first.routines[0].revision, replacement: null },
    ] })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await caller.get({ side: 'left' })).routines).toEqual(current.routines)
    expect(jobs.upsertPowerJob).not.toHaveBeenCalled()
  })

  it('does not overwrite a newly created day whose expected original was empty', async () => {
    await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })
    await expect(caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  it('protects managed rows from old calendar mutations, including partial batch writes', async () => {
    const saved = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] })
    const row = db.select().from(powerSchedules).get()
    assert(row)
    await expect(calendar.updatePowerSchedule({ id: row.id, enabled: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(calendar.deletePowerSchedule({ id: row.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(calendar.batchUpdate({ creates: { temperature: [{ side: 'right', dayOfWeek: 'monday', time: '22:30', temperature: 73 }] }, deletes: { power: [row.id] } })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(calendar.createTemperatureSchedule({ side: 'left', dayOfWeek: 'sunday', time: '03:00', temperature: 71 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await expect(calendar.batchUpdate({ notes: [{ side: 'left', dayOfWeek: 'saturday', notes: 'Partial calendar edit' }] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await caller.get({ side: 'left' })).routines).toEqual(saved.routines)
    expect((await calendar.getAll({ side: 'right' })).temperature).toEqual([])
    await expect(calendar.createTemperatureSchedule({ side: 'right', dayOfWeek: 'sunday', time: '03:00', temperature: 71 })).resolves.toBeDefined()
  })

  it('keeps legacy calendar schedules unchanged and requires deliberate migration', async () => {
    const row = await calendar.createTemperatureSchedule({ side: 'left', dayOfWeek: 'monday', time: '03:00', temperature: 71 })
    expect(await caller.get({ side: 'left' })).toMatchObject({ canCreate: false, routines: [] })
    await expect(caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await calendar.getAll({ side: 'left' })).temperature[0].id).toBe(row.id)
  })

  it('rejects overlapping enabled windows across the week boundary', async () => {
    const saturday = { ...draft, power: { ...draft.power, enabled: true } }
    const sunday = { ...draft, power: { ...draft.power, onTime: '06:00', offTime: '09:00', enabled: true }, temperatures: [], alarm: null }
    await expect(caller.replace({ side: 'left', changes: [
      { dayOfWeek: 'saturday', expectedRevision: null, replacement: saturday },
      { dayOfWeek: 'sunday', expectedRevision: null, replacement: sunday },
    ] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect((await caller.get({ side: 'left' })).routines).toEqual([])
  })

  it('rebases calendar weekdays when the power-on time changes', async () => {
    const first = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] })
    const moved = { ...draft, power: { ...draft.power, onTime: '00:30', offTime: '07:00', enabled: true } }
    await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: first.routines[0].revision, replacement: moved }] })
    expect(db.select().from(powerSchedules).get()).toMatchObject({ dayOfWeek: 'saturday', offDayOffset: 0 })
    expect(db.select().from(temperatureSchedules).get()).toMatchObject({ dayOfWeek: 'saturday', time: '01:00', enabled: true })
    expect(db.select().from(alarmSchedules).get()).toMatchObject({ dayOfWeek: 'saturday', enabled: true })
  })

  it('reports committed state separately when scheduler registration fails', async () => {
    vi.mocked(getJobManager).mockRejectedValueOnce(new Error('offline scheduler'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })
    expect(result.schedulerApplied).toBe(false)
    expect((await caller.get({ side: 'left' })).routines).toEqual(result.routines)
    log.mockRestore()
  })

  it('does not resurrect old jobs when scheduler initialization completes out of order', async () => {
    const manager = await getJobManager()
    let release: (() => void) | undefined
    vi.mocked(getJobManager).mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve(manager)
    }))
    const olderSave = caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })
    await vi.waitFor(() => expect(release).toBeDefined())
    const original = await caller.get({ side: 'left' })
    await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: original.routines[0].revision, replacement: { ...draft, notes: 'Newer save' } }] })
    const currentPower = db.select().from(powerSchedules).get()
    assert(currentPower)
    vi.clearAllMocks()
    assert(release)
    release()
    await olderSave
    expect(jobs.upsertPowerJob).not.toHaveBeenCalled()
    expect(jobs.upsertTemperatureJob).not.toHaveBeenCalled()
    expect(jobs.upsertAlarmJob).not.toHaveBeenCalled()
    expect(db.select().from(powerSchedules).get()?.id).toBe(currentPower.id)
  })

  it('rolls back all days and retains the original jobs when a later insert fails', async () => {
    const first = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })
    sqlite.exec('CREATE TRIGGER reject_tuesday BEFORE INSERT ON bedtime_routines WHEN NEW.day_of_week=\'tuesday\' BEGIN SELECT RAISE(ABORT, \'injected storage failure\'); END')
    vi.clearAllMocks()
    try {
      await expect(caller.replace({ side: 'left', changes: [
        { dayOfWeek: 'monday', expectedRevision: first.routines[0].revision, replacement: { ...draft, notes: 'Uncommitted' } },
        { dayOfWeek: 'tuesday', expectedRevision: null, replacement: draft },
      ] })).rejects.toThrow()
      expect((await caller.get({ side: 'left' })).routines).toEqual(first.routines)
      expect(jobs.cancelPowerJob).not.toHaveBeenCalled()
      expect(jobs.upsertPowerJob).not.toHaveBeenCalled()
    }
    finally { sqlite.exec('DROP TRIGGER reject_tuesday') }
  })

  it('deletes the entire routine and cancels each owned job', async () => {
    const first = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: null, replacement: draft }] })
    vi.clearAllMocks()
    const result = await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'saturday', expectedRevision: first.routines[0].revision, replacement: null }] })
    expect(result.routines).toEqual([])
    expect(await calendar.getAll({ side: 'left' })).toMatchObject({ temperature: [], power: [], alarm: [] })
    expect(jobs.cancelTemperatureJob).toHaveBeenCalledOnce()
    expect(jobs.cancelPowerJob).toHaveBeenCalledOnce()
    expect(jobs.cancelAlarmJob).toHaveBeenCalledOnce()
  })

  it('detects changes made directly to scheduler rows instead of claiming an intact routine', async () => {
    await caller.replace({ side: 'left', changes: [{ dayOfWeek: 'monday', expectedRevision: null, replacement: draft }] })
    sqlite.exec('UPDATE power_schedules SET on_temperature=90')
    await expect(caller.get({ side: 'left' })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
  })

  it('rejects malformed drafts and repeated days before touching storage', async () => {
    const change = { dayOfWeek: 'monday' as const, expectedRevision: null, replacement: draft }
    await expect(caller.replace({ side: 'left', changes: [change, change] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const invalid = { ...draft, temperatures: [{ time: '22:00', temperature: 71, enabled: true }] }
    await expect(caller.replace({ side: 'left', changes: [{ ...change, replacement: invalid }] })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect((await caller.get({ side: 'left' })).routines).toEqual([])
  })
})
