import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetControlDatabase } from '@/src/temperature/tests/databaseFixture'

const hardware = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  setTemperature: vi.fn<(side: string, temperature: number, duration?: number) => Promise<void>>(async () => {}),
  setPower: vi.fn<(side: string, on: boolean) => Promise<void>>(async () => {}),
}))
const scheduler = vi.hoisted(() => ({ cancelRunOnceSession: vi.fn(), scheduleRunOnceSession: vi.fn() }))
const guard = vi.hoisted(() => ({ shouldBlock: vi.fn(() => false) }))
vi.mock('@/src/scheduler', () => ({ getJobManager: async () => scheduler }))
vi.mock('@/src/hardware/pumpStallGuard', () => guard)
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getSharedHardwareClient: () => hardware }))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({ broadcastMutationStatus: vi.fn() }))
vi.mock('@/src/hardware/deviceStateSync', () => ({ markSideMutated: vi.fn() }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const sqlite = new Database(':memory:')
  return { sqlite, db: drizzle(sqlite, { schema }) }
})

import { db, sqlite } from '@/src/db'
import { deviceSettings, deviceState, runOnceSessions, temperatureSchedules } from '@/src/db/schema'
import { runOnceRouter } from '../runOnce'
import { getTemperatureController } from '@/src/temperature/instance'
import { withSideLock } from '@/src/hardware/sideLock'

const caller = runOnceRouter.createCaller({})
const input = { side: 'left' as const, setPoints: [{ time: '22:00', temperature: 74 }, { time: '23:00', temperature: 68 }], wakeTime: '07:00' }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-28T22:00:00Z'))
  vi.resetAllMocks()
  guard.shouldBlock.mockReturnValue(false)
  resetControlDatabase(sqlite)
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC' }).run()
  db.insert(deviceState).values({ side: 'left', isPowered: false }).run()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function activeRows() {
  return db.select().from(runOnceSessions).where(eq(runOnceSessions.status, 'active')).all()
}

describe('run-once API with real controller and SQLite transactions', () => {
  it('commits the session before resolving its first target, then schedules remaining points', async () => {
    hardware.setTemperature.mockImplementationOnce(async () => {
      expect(activeRows()).toHaveLength(1)
    })
    const result = await caller.start(input)
    expect(result.expiresAt).toBe(Date.parse('2026-09-29T07:00Z') / 1000)
    expect(hardware.setTemperature).toHaveBeenCalledWith('left', 74)
    expect(scheduler.scheduleRunOnceSession).toHaveBeenCalledWith(result.sessionId, 'left', [input.setPoints[1]], '07:00', 'UTC')
    expect(activeRows()[0].setPoints).toBe(JSON.stringify(input.setPoints))
  })

  it('keeps a manual hold in control while starting the run-once clock', async () => {
    const control = getTemperatureController()
    await control.setManual('left', 77)
    const expiry = control.status('left').holdUntil
    await caller.start(input)
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 77)
    expect(control.status('left').holdUntil).toBe(expiry)
    vi.setSystemTime(new Date('2026-09-28T23:15Z'))
    await control.resume('left')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 68)
  })

  it('replaces only the same side and cancels its old jobs after the new command succeeds', async () => {
    const old = await caller.start(input)
    const right = await caller.start({ ...input, side: 'right' })
    scheduler.cancelRunOnceSession.mockClear()
    const next = await caller.start({ ...input, setPoints: [{ time: '22:00', temperature: 70 }] })
    expect(activeRows().map(row => row.id)).toEqual([right.sessionId, next.sessionId])
    expect(db.select().from(runOnceSessions).where(eq(runOnceSessions.id, old.sessionId)).get()?.status).toBe('cancelled')
    expect(scheduler.cancelRunOnceSession).toHaveBeenCalledExactlyOnceWith('left', old.sessionId)
  })

  it('uses America/Los_Angeles when settings are missing', async () => {
    db.delete(deviceSettings).run()
    const result = await caller.start({ ...input, wakeTime: '23:00' })
    expect(scheduler.scheduleRunOnceSession).toHaveBeenCalledWith(result.sessionId, 'left', [input.setPoints[1]], '23:00', 'America/Los_Angeles')
  })

  it('rejects overlong sessions before changing an existing session and accepts exactly 14 hours', async () => {
    const previous = await caller.start(input)
    await expect(caller.start({ ...input, wakeTime: '13:00' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('15h') })
    expect(activeRows()[0].id).toBe(previous.sessionId)
    const accepted = await caller.start({ ...input, wakeTime: '12:00' })
    expect(accepted.expiresAt * 1000 - Date.now()).toBe(14 * 3_600_000)
  })

  it('refuses a guard-blocked start before changing sessions', async () => {
    guard.shouldBlock.mockReturnValue(true)
    await expect(caller.start(input)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    expect(activeRows()).toHaveLength(0)
    expect(hardware.setTemperature).not.toHaveBeenCalled()
    expect(scheduler.cancelRunOnceSession).not.toHaveBeenCalled()
  })

  it('rechecks protection after a start waits for the side lock', async () => {
    let release = () => {}
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    const pending = caller.start(input)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' })
    await vi.advanceTimersByTimeAsync(0)
    guard.shouldBlock.mockReturnValue(true)
    release()
    await holder
    await assertion
    expect(activeRows()).toHaveLength(0)
    expect(hardware.setTemperature).not.toHaveBeenCalled()
  })

  it.each(['left', 'right'] as const)('rolls back an insert failure on %s without commanding hardware', async (side) => {
    const old = await caller.start({ ...input, side })
    vi.clearAllMocks()
    sqlite.exec('CREATE TRIGGER reject_run_once BEFORE INSERT ON run_once_sessions BEGIN SELECT RAISE(ABORT, \'insert failed\'); END')
    await expect(caller.start({ ...input, side })).rejects.toThrow('insert failed')
    expect(activeRows().map(row => row.id)).toEqual([old.sessionId])
    expect(hardware.setTemperature).not.toHaveBeenCalled()
    expect(hardware.setPower).not.toHaveBeenCalled()
    expect(scheduler.cancelRunOnceSession).not.toHaveBeenCalled()
  })

  it('reactivates the previous session after a failed hardware start and restores its current target', async () => {
    const old = await caller.start(input)
    scheduler.cancelRunOnceSession.mockClear()
    hardware.setTemperature.mockRejectedValueOnce(new Error('write failed'))
    await expect(caller.start({ ...input, setPoints: [{ time: '22:00', temperature: 80 }] })).rejects.toThrow('write failed')
    expect(activeRows().map(row => row.id)).toEqual([old.sessionId])
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 74)
    expect(scheduler.cancelRunOnceSession).not.toHaveBeenCalledWith('left', old.sessionId)
  })

  it('rolls back a scheduler registration failure without losing the prior session jobs', async () => {
    const old = await caller.start(input)
    hardware.setTemperature.mockClear()
    scheduler.cancelRunOnceSession.mockClear()
    scheduler.scheduleRunOnceSession.mockImplementationOnce(() => {
      throw new Error('scheduler unavailable')
    })
    await expect(caller.start(input)).rejects.toThrow('scheduler unavailable')
    expect(activeRows().map(row => row.id)).toEqual([old.sessionId])
    expect(scheduler.cancelRunOnceSession).not.toHaveBeenCalledWith('left', old.sessionId)
    expect(hardware.setTemperature).not.toHaveBeenCalled()
  })

  it('cuts off a partially failed first start and preserves the original error when cutoff also fails', async () => {
    hardware.setTemperature.mockRejectedValueOnce(new Error('start failed'))
    hardware.setPower.mockRejectedValueOnce(new Error('cutoff failed'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(caller.start(input)).rejects.toThrow('start failed')
    expect(activeRows()).toHaveLength(0)
    expect(hardware.setPower).toHaveBeenCalledWith('left', false)
    expect(warn).toHaveBeenCalledWith('[runOnce] Failed to restore hardware after rejected start:', expect.any(Error))
  })

  it('does not discard an existing manual hold when a run-once power command fails', async () => {
    const control = getTemperatureController()
    await control.setManual('left', 77)
    const expiry = control.status('left').holdUntil
    hardware.setTemperature.mockRejectedValueOnce(new Error('start failed'))
    await expect(caller.start(input)).rejects.toThrow('start failed')
    expect(control.status('left')).toMatchObject({ source: 'manual', targetTemperature: 77, holdUntil: expiry })
    expect(hardware.setPower).not.toHaveBeenCalled()
  })

  it('returns parsed active sessions, and filters cancelled and expired sessions', async () => {
    expect(await caller.getActive({ side: 'left' })).toBeNull()
    const result = await caller.start(input)
    expect(await caller.getActive({ side: 'left' })).toMatchObject({ id: result.sessionId, setPoints: input.setPoints, startedAt: Date.now() / 1000 })
    vi.setSystemTime(new Date('2026-09-29T07:00Z'))
    expect(await caller.getActive({ side: 'left' })).toBeNull()
  })

  it.each(['invalid json', '{}', '[{"time":"bad","temperature":900}]'])('returns empty points for corrupted stored JSON %s', async (setPoints) => {
    const result = await caller.start(input)
    db.update(runOnceSessions).set({ setPoints }).where(eq(runOnceSessions.id, result.sessionId)).run()
    expect(await caller.getActive({ side: 'left' })).toMatchObject({ setPoints: [] })
  })

  it('cancels under the shared lock and immediately restores the applicable recurring point', async () => {
    await caller.start(input)
    db.insert(temperatureSchedules).values({ side: 'left', dayOfWeek: 'monday', time: '21:00', temperature: 71 }).run()
    expect(await caller.cancel({ side: 'left' })).toEqual({ success: true })
    expect(activeRows()).toHaveLength(0)
    expect(scheduler.cancelRunOnceSession).toHaveBeenLastCalledWith('left')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 71)
  })
})
