/**
 * curveTemplates router against a real in-memory sleepypod.db with
 * migrations applied.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import * as mainSchema from '@/src/db/schema'
import { compileBedtimeRoutine, type BedtimeDraft } from '@/src/lib/bedtimeRoutines'

const dbHolder = vi.hoisted(() => ({ main: null as unknown }))
const jobs = vi.hoisted(() => ({ calls: [] as string[], rows: [] as unknown[], committed: [] as boolean[], probe: null as null | (() => boolean), start: vi.fn<() => Promise<void>>() }))

vi.mock('@/src/db', () => ({
  get db() { return dbHolder.main },
}))

// Records every job change, and whether the schedule rows were already committed when it ran.
vi.mock('@/src/scheduler', () => ({
  getJobManager: async () => {
    await jobs.start()
    const record = (kind: string) => (arg: number | { id: number }) => {
      jobs.calls.push(`${kind}:${typeof arg === 'number' ? arg : arg.id}`)
      if (typeof arg !== 'number') jobs.rows.push(arg)
      if (jobs.probe) jobs.committed.push(jobs.probe())
    }
    return {
      upsertTemperatureJob: record('upsertTemperature'),
      cancelTemperatureJob: record('cancelTemperature'),
      upsertPowerJob: record('upsertPower'),
      cancelPowerJob: record('cancelPower'),
    }
  },
}))

const { curveTemplatesRouter } = await import('@/src/server/routers/curveTemplates')
const caller = curveTemplatesRouter.createCaller({})

const LATE_WARM = { name: 'Late Warm', bedtime: '01:30', wake: '10:30', points: { '00:45': 83, '02:30': 78, '11:00': 82 }, notes: 'Warm sleeper.' }

describe('curveTemplates router', () => {
  let raw: Database.Database

  let main: ReturnType<typeof drizzle<typeof mainSchema>>

  beforeEach(() => {
    raw = new Database(':memory:')
    main = drizzle(raw, { schema: mainSchema })
    migrate(main, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
    dbHolder.main = main
    jobs.calls = []
    jobs.rows = []
    jobs.start.mockReset().mockResolvedValue(undefined)
    jobs.committed = []
    jobs.probe = null
  })

  afterEach(() => {
    raw.close()
    vi.useRealTimers()
  })

  /** Each day's set points ("HH:mm@°F") on a side, plus its power window and note. */
  function sideRows(side: 'left' | 'right') {
    const out: Record<string, { temps: string[], power?: string, notes?: string }> = {}
    const day = (d: string) => (out[d] ??= { temps: [] })
    for (const t of main.select().from(mainSchema.temperatureSchedules).where(eq(mainSchema.temperatureSchedules.side, side)).all()) {
      day(t.dayOfWeek).temps.push(`${t.time}@${t.temperature}`)
    }
    for (const p of main.select().from(mainSchema.powerSchedules).where(eq(mainSchema.powerSchedules.side, side)).all()) {
      day(p.dayOfWeek).power = `${p.onTime}-${p.offTime}@${p.onTemperature}:${p.endAction}`
    }
    for (const n of main.select().from(mainSchema.scheduleNotes).where(eq(mainSchema.scheduleNotes.side, side)).all()) {
      day(n.dayOfWeek).notes = n.notes
    }
    for (const v of Object.values(out)) v.temps.sort()
    return out
  }

  const NIGHT = { '22:00': 70, '02:00': 66, '06:30': 78 }
  const NIGHT_ROWS = { temps: ['02:00@66', '06:30@78', '22:00@70'], power: '22:00-06:30@70:turn_off' }
  const curve = (name: string, days: { left?: string[], right?: string[] }, active = true, extra: Record<string, unknown> = {}) =>
    caller.put({ name, bedtime: '22:00', wake: '06:30', points: NIGHT, days: days as never, active, ...extra })

  function importedNight(side: 'left' | 'right') {
    const draft: BedtimeDraft = {
      power: { onTime: '22:00', offTime: '07:00', onTemperature: 75, enabled: false, endAction: 'turn_off' },
      temperatures: [{ time: '01:00', temperature: 73, enabled: true }],
      alarm: { time: '06:30', vibrationIntensity: 50, vibrationPattern: 'rise', duration: 30, alarmTemperature: 80, wakeWindow: 0, snoozeDuration: 540, snoozeTaper: 40, enabled: true }, notes: 'Imported night',
    }
    const compiled = compileBedtimeRoutine(side, { dayOfWeek: 'saturday', draft })
    const ids = {
      temperature: compiled.temperature.map(row => main.insert(mainSchema.temperatureSchedules).values(row).returning().get().id),
      power: compiled.power.map(row => main.insert(mainSchema.powerSchedules).values(row).returning().get().id),
      alarm: compiled.alarm.map(row => main.insert(mainSchema.alarmSchedules).values(row).returning().get().id),
    }
    main.insert(mainSchema.bedtimeRoutines).values({ side, dayOfWeek: 'saturday', configuration: JSON.stringify(draft), scheduleIds: JSON.stringify(ids) }).run()
    return ids
  }

  it('rolls back a both-side claim when one side belongs to an imported overnight routine', async () => {
    importedNight('right')
    const before = raw.serialize()
    await expect(curve('Both', { left: ['saturday'], right: ['saturday'] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(raw.serialize()).toEqual(before)
    expect(jobs.calls).toEqual([])
  })

  it('allows an inactive template but refuses activation over a complete night', async () => {
    importedNight('left')
    const saved = await curve('Later', { left: ['saturday'] }, false)
    expect(saved.curve.active).toBe(false)
    await expect(caller.setActive({ id: saved.curve.id, active: true })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect((await caller.list({}))[0].active).toBe(false)
    expect(main.select().from(mainSchema.alarmSchedules).get()).toMatchObject({ enabled: false, snoozeDuration: 540, snoozeTaper: 40 })
  })

  it('refuses to discard an explicit next-day shutdown without bedtime ownership', async () => {
    main.insert(mainSchema.powerSchedules).values({ side: 'left', dayOfWeek: 'saturday', onTime: '22:00', offTime: '07:00', offDayOffset: 1, onTemperature: 75 }).run()
    await expect(curve('Unsafe conversion', { left: ['saturday'] })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(main.select().from(mainSchema.powerSchedules).get()?.offDayOffset).toBe(1)
    expect(await caller.list({})).toEqual([])
  })

  it('keeps paused days paused when editing their active library curve', async () => {
    const saved = await curve('Paused', { left: ['monday'] })
    main.update(mainSchema.temperatureSchedules).set({ enabled: false }).run()
    main.update(mainSchema.powerSchedules).set({ enabled: false }).run()
    await curve('Paused', { left: ['monday'] }, true, { id: saved.curve.id, points: { ...NIGHT, '03:00': 67 } })
    expect(main.select().from(mainSchema.temperatureSchedules).all().every(row => !row.enabled)).toBe(true)
    expect(main.select().from(mainSchema.powerSchedules).get()?.enabled).toBe(false)
    await caller.setActive({ id: saved.curve.id, active: false })
    await caller.setActive({ id: saved.curve.id, active: true })
    expect(main.select().from(mainSchema.temperatureSchedules).all().every(row => row.enabled)).toBe(true)
  })

  it('reports committed state separately when scheduler registration fails', async () => {
    jobs.start.mockRejectedValueOnce(new Error('scheduler unavailable'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await curve('Pending', { left: ['monday'] })
      expect(result.schedulerApplied).toBe(false)
      expect(result.curve.active).toBe(true)
      expect((await caller.list({}))[0].id).toBe(result.curve.id)
      expect(sideRows('left').monday).toEqual(NIGHT_ROWS)
    }
    finally { log.mockRestore() }
  })

  it('does not register rows deleted by a newer save during scheduler startup', async () => {
    let resume = () => {}
    jobs.start.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resume = resolve
    }))
    const first = curve('Replaced', { left: ['monday'] })
    await vi.waitFor(() => expect(main.select().from(mainSchema.curveTemplates).all()).toHaveLength(1))
    const original = main.select().from(mainSchema.curveTemplates).get()
    if (!original) throw new Error('Expected saved curve')
    const oldIds = main.select().from(mainSchema.temperatureSchedules).all().map(row => row.id)
    try {
      await curve('Replaced', { left: ['tuesday'] }, true, { id: original.id })
    }
    finally {
      resume()
      await first
    }
    for (const id of oldIds) expect(jobs.calls).not.toContain(`upsertTemperature:${id}`)
    expect(Object.keys(sideRows('left'))).toEqual(['tuesday'])
  })

  it('registers current values after an in-place edit during scheduler startup', async () => {
    let resume = () => {}
    jobs.start.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resume = resolve
    }))
    const first = curve('Edited', { left: ['monday'] })
    await vi.waitFor(() => expect(main.select().from(mainSchema.temperatureSchedules).all().length).toBeGreaterThan(0))
    const current = main.select().from(mainSchema.temperatureSchedules).get()
    if (!current) throw new Error('Expected scheduled temperature')
    try {
      main.update(mainSchema.temperatureSchedules).set({ temperature: 79 }).where(eq(mainSchema.temperatureSchedules.id, current.id)).run()
    }
    finally {
      resume()
      await first
    }
    expect(jobs.rows).toContainEqual(expect.objectContaining({ id: current.id, temperature: 79 }))
    expect(jobs.rows).not.toContainEqual(expect.objectContaining({ id: current.id, temperature: current.temperature }))
  })

  it('saves, lists newest first and replaces by name', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-13T20:00:00Z'))
    const saved = await caller.save(LATE_WARM)
    expect(saved).toMatchObject({ ...LATE_WARM, id: expect.any(Number) })
    vi.setSystemTime(new Date('2026-10-13T21:00:00Z'))
    await caller.save({ name: 'Deep Cool', bedtime: '22:00', wake: '06:30', points: { '22:00': 70, '06:30': 80 } })
    expect((await caller.list({})).map(t => t.name)).toEqual(['Deep Cool', 'Late Warm'])

    vi.setSystemTime(new Date('2026-10-13T22:00:00Z'))
    const replaced = await caller.save({ ...LATE_WARM, points: { '01:00': 80, '10:00': 84 }, notes: '' })
    expect(replaced.id).toBe(saved.id)
    expect(replaced.createdAt).toEqual(saved.createdAt)
    const list = await caller.list({})
    expect(list.map(t => t.name)).toEqual(['Late Warm', 'Deep Cool'])
    expect(list[0].points).toEqual({ '01:00': 80, '10:00': 84 })
  })

  it('trims names and rejects bad points', async () => {
    expect((await caller.save({ ...LATE_WARM, name: '  Spaced  ' })).name).toBe('Spaced')
    await expect(caller.save({ ...LATE_WARM, points: { '22:00': 70 } })).rejects.toThrow('2-48 set points')
    await expect(caller.save({ ...LATE_WARM, points: { '22:00': 50, '06:00': 80 } })).rejects.toThrow()
    await expect(caller.save({ ...LATE_WARM, points: { '25:00': 70, '06:00': 80 } })).rejects.toThrow()
    await expect(caller.save({ ...LATE_WARM, name: 'x'.repeat(31) })).rejects.toThrow()
  })

  it('deletes by name and reports whether anything was deleted', async () => {
    await caller.save(LATE_WARM)
    expect(await caller.delete({ name: 'Late Warm' })).toEqual({ deleted: true, schedulerApplied: true })
    expect(await caller.delete({ name: 'Late Warm' })).toEqual({ deleted: false, schedulerApplied: true })
    expect(await caller.list({})).toEqual([])
  })

  it('wraps database failures as INTERNAL_SERVER_ERROR', async () => {
    dbHolder.main = {
      select: () => {
        throw new Error('disk gone')
      },
    }
    await expect(caller.list({})).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to list saved curves: disk gone' })
  })

  it('lists days, active and end action, with new curves saved off and without days', async () => {
    await caller.save(LATE_WARM)
    const [t] = await caller.list({})
    expect(t).toMatchObject({ endAction: 'turn_off', days: { left: [], right: [] }, active: false })
    expect(t).not.toHaveProperty('leftDays')
    expect(sideRows('left')).toEqual({})
  })

  it('put creates an active curve and writes its rows, power window and note on each side and day', async () => {
    const { curve: created, moved } = await curve('Weeknight', { left: ['tuesday', 'monday', 'monday'], right: ['monday'] }, true, { notes: 'Cool start' })
    expect(created).toMatchObject({ name: 'Weeknight', active: true, days: { left: ['monday', 'tuesday'], right: ['monday'] } })
    expect(moved).toEqual([])
    const day = { ...NIGHT_ROWS, notes: 'Cool start' }
    expect(sideRows('left')).toEqual({ monday: day, tuesday: day })
    expect(sideRows('right')).toEqual({ monday: day })
    expect(jobs.calls.filter(c => c.startsWith('upsertTemperature'))).toHaveLength(9)
    expect(jobs.calls.filter(c => c.startsWith('upsertPower'))).toHaveLength(3)
  })

  it('put with maintain writes a maintain power window', async () => {
    await curve('Hold', { left: ['friday'] }, true, { endAction: 'maintain' })
    expect(sideRows('left').friday.power).toBe('22:00-06:30@70:maintain')
  })

  it('put saves an active curve with no days as off and writes nothing', async () => {
    const { curve: c } = await curve('Nowhere', {}, true)
    expect(c.active).toBe(false)
    expect(sideRows('left')).toEqual({})
    expect(jobs.calls).toEqual([])
  })

  it('put moves shared days per side from other active curves and turns off a curve left with none', async () => {
    const a = (await curve('A', { left: ['monday', 'tuesday'], right: ['monday'] })).curve
    const b = (await curve('B', { left: ['wednesday'] })).curve
    await curve('Off', { left: ['monday'] }, false)
    const { moved } = await caller.put({ name: 'C', bedtime: '23:00', wake: '07:00', points: { '23:00': 75, '07:00': 80 }, days: { left: ['monday', 'wednesday'], right: [] }, active: true })
    expect(moved).toEqual([
      { name: 'A', side: 'left', days: ['monday'], deactivated: false },
      { name: 'B', side: 'left', days: ['wednesday'], deactivated: true },
    ])
    const byName = Object.fromEntries((await caller.list({})).map(t => [t.name, t]))
    expect(byName.A).toMatchObject({ id: a.id, active: true, days: { left: ['tuesday'], right: ['monday'] } })
    expect(byName.B).toMatchObject({ id: b.id, active: false, days: { left: [], right: [] } })
    // Inactive curves keep their days; they never run.
    expect(byName.Off).toMatchObject({ active: false, days: { left: ['monday'], right: [] } })
    const left = sideRows('left')
    expect(left.monday.temps).toEqual(['07:00@80', '23:00@75'])
    expect(left.wednesday.temps).toEqual(['07:00@80', '23:00@75'])
    expect(left.tuesday).toEqual(NIGHT_ROWS)
    expect(sideRows('right').monday).toEqual(NIGHT_ROWS)
  })

  it('put updates by id: renames, clears days it gave up and keeps the other side', async () => {
    const { curve: c } = await curve('Week', { left: ['monday', 'tuesday'], right: ['sunday'] })
    await caller.put({ id: c.id, name: 'Weekday', bedtime: '22:00', wake: '07:00', points: { '22:00': 72, '07:00': 80 }, days: { left: ['tuesday'], right: ['sunday'] }, active: true })
    const left = sideRows('left')
    expect(left.monday).toBeUndefined()
    expect(left.tuesday.temps).toEqual(['07:00@80', '22:00@72'])
    expect(sideRows('right').sunday.temps).toEqual(['07:00@80', '22:00@72'])
    expect((await caller.list({})).map(t => t.name)).toEqual(['Weekday'])
    await expect(caller.put({ id: 9999, name: 'X', bedtime: '22:00', wake: '07:00', points: NIGHT, days: { left: [], right: [] }, active: false }))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('put turning a curve off clears its days and keeps alarms and other days', async () => {
    const { curve: c } = await curve('Week', { left: ['monday'] })
    await curve('Other', { left: ['friday'] })
    main.insert(mainSchema.alarmSchedules).values({ side: 'left', dayOfWeek: 'monday', time: '07:00', vibrationIntensity: 50, duration: 60, alarmTemperature: 80 }).run()
    const { curve: off } = await caller.put({ id: c.id, name: 'Week', bedtime: '22:00', wake: '06:30', points: NIGHT, days: { left: ['monday'], right: [] }, active: false })
    expect(off).toMatchObject({ active: false, days: { left: ['monday'], right: [] } })
    expect(Object.keys(sideRows('left'))).toEqual(['friday'])
    expect(main.select().from(mainSchema.alarmSchedules).all()).toHaveLength(1)
  })

  it('rejects a duplicate name as CONFLICT', async () => {
    await curve('Same', { left: ['monday'] })
    await expect(curve('Same', { left: ['tuesday'] })).rejects.toMatchObject({ code: 'CONFLICT', message: 'Another curve already has that name' })
  })

  it('save replaces set points by name, keeps days and rewrites an active curve', async () => {
    await curve('Week', { left: ['monday'] })
    const saved = await caller.save({ name: 'Week', bedtime: '21:00', wake: '06:00', points: { '21:00': 74, '06:00': 82 }, endAction: 'maintain' })
    expect(saved).toMatchObject({ active: true, days: { left: ['monday'], right: [] }, endAction: 'maintain' })
    expect(sideRows('left').monday).toEqual({ temps: ['06:00@82', '21:00@74'], power: '21:00-06:00@74:maintain' })

    // Without endAction the saved one is kept; an inactive curve writes nothing.
    await curve('Idle', { left: ['friday'] }, false, { endAction: 'maintain' })
    expect((await caller.save({ name: 'Idle', bedtime: '21:00', wake: '06:00', points: { '21:00': 74, '06:00': 82 } })).endAction).toBe('maintain')
    expect(sideRows('left').friday).toBeUndefined()
  })

  it('setActive turns a curve off and back on, moving days back from others', async () => {
    const { curve: a } = await curve('A', { left: ['monday', 'tuesday'] })
    expect(await caller.setActive({ id: a.id, active: true })).toMatchObject({ moved: [] })
    const off = await caller.setActive({ id: a.id, active: false })
    expect(off).toMatchObject({ curve: { active: false, days: { left: ['monday', 'tuesday'], right: [] } }, moved: [] })
    expect(sideRows('left')).toEqual({})

    await curve('B', { left: ['tuesday'] })
    const on = await caller.setActive({ id: a.id, active: true })
    expect(on.moved).toEqual([{ name: 'B', side: 'left', days: ['tuesday'], deactivated: true }])
    expect(sideRows('left')).toEqual({ monday: NIGHT_ROWS, tuesday: NIGHT_ROWS })
  })

  it('setActive refuses a curve without days and an unknown id', async () => {
    const t = await caller.save(LATE_WARM)
    await expect(caller.setActive({ id: t.id, active: true })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Pick days for Late Warm before turning it on' })
    await expect(caller.setActive({ id: 9999, active: false })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await caller.setActive({ id: t.id, active: false })).curve.active).toBe(false)
  })

  it('deleting an active curve clears its rows and notes', async () => {
    await curve('Week', { left: ['monday'], right: ['monday'] }, true, { notes: 'n' })
    jobs.calls = []
    expect(await caller.delete({ name: 'Week' })).toEqual({ deleted: true, schedulerApplied: true })
    expect(sideRows('left')).toEqual({})
    expect(sideRows('right')).toEqual({})
    expect(jobs.calls.filter(c => c.startsWith('cancelTemperature'))).toHaveLength(6)
    expect(jobs.calls.filter(c => c.startsWith('cancelPower'))).toHaveLength(2)
  })

  it('hands the scheduler its job changes only after the rows are committed', async () => {
    jobs.probe = () => !raw.inTransaction && main.select().from(mainSchema.temperatureSchedules).all().length > 0
    await curve('Week', { left: ['monday'] })
    expect(jobs.committed.length).toBeGreaterThan(0)
    expect(jobs.committed.every(Boolean)).toBe(true)
  })
})
