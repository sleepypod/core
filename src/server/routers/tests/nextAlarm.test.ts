import { required } from '@/src/alarms/tests/required'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { alarmFixture } from '@/src/alarms/tests/fixture'
import type { createAlarmStore } from '@/src/alarms/store'
const holder = vi.hoisted(() => ({ store: undefined as ReturnType<typeof createAlarmStore> | undefined, synchronize: vi.fn(async () => true) }))
vi.mock('@/src/alarms/instance', () => ({ alarmStore: () => holder.store }))
vi.mock('@/src/server/scheduleLibrary', () => ({ applyScheduler: holder.synchronize }))
const { nextAlarmRouter } = await import('../nextAlarm')
const caller = nextAlarmRouter.createCaller({})
let fixture: ReturnType<typeof alarmFixture>
beforeEach(() => {
  fixture = alarmFixture()
  holder.store = fixture.store
  vi.useFakeTimers()
  vi.setSystemTime(fixture.now)
  holder.synchronize.mockClear()
})
afterEach(() => {
  fixture.database.close()
  vi.useRealTimers()
})
it('reads without starting a scheduler, writes one occurrence, and returns conflict on replay', async () => {
  const page = await caller.get({ side: 'left' })
  expect(holder.synchronize).not.toHaveBeenCalled()
  const input = { side: 'left' as const, action: 'skip' as const, expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at }
  expect(await caller.change(input)).toMatchObject({ state: 'skipped', schedulerUpdated: true })
  expect(holder.synchronize).toHaveBeenCalledTimes(1)
  await expect(caller.change(input)).rejects.toMatchObject({ code: 'CONFLICT' })
  expect((await caller.get({ side: 'right' })).state).toBe('none')
})
it('previews a later alarm without registering timers or mutating the saved occurrence', async () => {
  const page = await caller.get({ side: 'left' })
  const preview = await caller.previewLater({ side: 'left', time: '09:00', expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at })
  expect(preview.proposed.at).toBe('2026-10-26T09:00:00.000Z')
  expect(await caller.get({ side: 'left' })).toEqual(page)
  expect(holder.synchronize).not.toHaveBeenCalled()
  await expect(caller.previewLater({ side: 'left', time: '06:00', expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
})
it('rejects malformed requests, returns precise clock errors and masks storage errors', async () => {
  const page = await caller.get({ side: 'left' })
  await expect(caller.change({ side: 'left', action: 'time', time: '04:00', expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  await expect(caller.change({ side: 'left', action: 'skip', expectedRevision: 'unknown' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  fixture.database.exec('DROP TABLE alarm_overrides')
  await expect(caller.get({ side: 'left' })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'The next alarm could not be confirmed. Refresh before trying again.' })
})

it('applies the reviewed plan once and preserves a partial scheduler result', async () => {
  const page = await caller.get({ side: 'left' })
  const preview = await caller.previewLater({ side: 'left', time: '09:00', expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at })
  holder.synchronize.mockResolvedValueOnce(false)
  const saved = await caller.applyLater({ preview })
  expect(saved).toMatchObject({ schedulerUpdated: false, alarm: { time: '09:00' } })
  expect(holder.synchronize).toHaveBeenCalledTimes(1)
  await expect(caller.applyLater({ preview })).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(holder.synchronize).toHaveBeenCalledTimes(1)
  expect((await caller.get({ side: 'left' })).alarm?.time).toBe('09:00')
})
it('does not synchronize or persist an expired review', async () => {
  const page = await caller.get({ side: 'left' })
  const preview = await caller.previewLater({ side: 'left', time: '09:00', expectedRevision: page.revision, expectedAt: required(page.alarm, 'alarm fixture').at })
  vi.setSystemTime(Date.parse(preview.expiresAt))
  await expect(caller.applyLater({ preview })).rejects.toMatchObject({ code: 'CONFLICT' })
  expect(holder.synchronize).not.toHaveBeenCalled()
  expect((await caller.get({ side: 'left' })).alarm?.time).toBe('07:00')
})
