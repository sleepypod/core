/**
 * curveTemplates router against a real in-memory sleepypod.db with
 * migrations applied.
 */

import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as mainSchema from '@/src/db/schema'

const dbHolder = vi.hoisted(() => ({ main: null as unknown }))

vi.mock('@/src/db', () => ({
  get db() { return dbHolder.main },
}))

const { curveTemplatesRouter } = await import('@/src/server/routers/curveTemplates')
const caller = curveTemplatesRouter.createCaller({})

const LATE_WARM = { name: 'Late Warm', bedtime: '01:30', wake: '10:30', points: { '00:45': 83, '02:30': 78, '11:00': 82 }, reasoning: 'Warm sleeper.' }

describe('curveTemplates router', () => {
  let raw: Database.Database

  beforeEach(() => {
    raw = new Database(':memory:')
    const main = drizzle(raw, { schema: mainSchema })
    migrate(main, { migrationsFolder: path.resolve(process.cwd(), 'src/db/migrations') })
    dbHolder.main = main
  })

  afterEach(() => {
    raw.close()
    vi.useRealTimers()
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
    const replaced = await caller.save({ ...LATE_WARM, points: { '01:00': 80, '10:00': 84 }, reasoning: '' })
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
    expect(await caller.delete({ name: 'Late Warm' })).toEqual({ deleted: true })
    expect(await caller.delete({ name: 'Late Warm' })).toEqual({ deleted: false })
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
})
