import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { resetControlDatabase } from './databaseFixture'

const hardware = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  setTemperature: vi.fn<(side: string, temperature: number, duration?: number) => Promise<void>>(async () => {}),
  setPower: vi.fn<(side: string, on: boolean) => Promise<void>>(async () => {}),
}))
const safety = vi.hoisted(() => ({ blocked: false }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getSharedHardwareClient: () => hardware }))
vi.mock('@/src/hardware/pumpStallGuard', () => ({ shouldBlock: () => safety.blocked }))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({ broadcastMutationStatus: vi.fn() }))
vi.mock('@/src/hardware/deviceStateSync', () => ({ markSideMutated: vi.fn() }))
vi.mock('@/src/db', async () => {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  const schema = await import('@/src/db/schema')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sleepypod-control-'))
  const filename = path.join(directory, 'control.db')
  let sqlite = new Database(filename)
  let currentDb = drizzle(sqlite, { schema })
  return {
    get sqlite() { return sqlite },
    get db() { return currentDb },
    reopenForTest() {
      sqlite.close()
      sqlite = new Database(filename)
      currentDb = drizzle(sqlite, { schema })
    },
    cleanupForTest() {
      sqlite.close()
      fs.rmSync(directory, { recursive: true, force: true })
    },
  }
})

import { db, sqlite } from '@/src/db'
import * as databaseModule from '@/src/db'
import { deviceSettings, deviceState, runOnceSessions, sideSettings, temperatureHolds, temperatureSchedules } from '@/src/db/schema'
import { getTemperatureController, startTemperatureController, stopTemperatureController } from '../instance'
import { withSideLock } from '@/src/hardware/sideLock'

const fileDatabase = databaseModule as typeof databaseModule & { reopenForTest: () => void, cleanupForTest: () => void }
afterAll(() => fileDatabase.cleanupForTest())

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-28T22:00:00Z'))
  safety.blocked = false
  vi.clearAllMocks()
  resetControlDatabase(sqlite)
  db.insert(deviceSettings).values({ id: 1, timezone: 'UTC' }).run()
  db.insert(sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).run()
  db.insert(deviceState).values([
    { side: 'left', isPowered: true, targetTemperature: 75 },
    { side: 'right', isPowered: true, targetTemperature: 75 },
  ]).run()
  db.insert(temperatureSchedules).values([
    { side: 'left', dayOfWeek: 'monday', time: '21:00', temperature: 72 },
    { side: 'left', dayOfWeek: 'monday', time: '22:15', temperature: 68 },
  ]).run()
})

afterEach(() => {
  stopTemperatureController()
  vi.useRealTimers()
})

describe('production controller with migrated SQLite', () => {
  it('keeps a dial target across a schedule step, then resolves the current point on expiry', async () => {
    const controller = getTemperatureController()
    await controller.setManual('left', 76)
    vi.setSystemTime(new Date('2026-09-28T22:20:00Z'))
    await controller.reconcile('left')
    expect(hardware.setTemperature).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date('2026-09-28T22:30:00Z'))
    await controller.reconcile('left')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 68)
    expect(db.select().from(temperatureHolds).all()).toHaveLength(0)
  })

  it('restores the saved hold after singleton recreation without extending its deadline', async () => {
    await getTemperatureController().setManual('left', 76)
    const persisted = db.select().from(temperatureHolds).get()
    delete (globalThis as Record<string, unknown>).__sp_temperatureController
    vi.setSystemTime(new Date('2026-09-28T22:10:00Z'))
    const restarted = getTemperatureController()
    await restarted.reconcile('left')
    expect(restarted.status('left').holdUntil).toBe(persisted?.expiresAt)
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 76)
    expect(db.select().from(temperatureHolds).get()).toEqual(persisted)
  })

  it('reopens the actual SQLite file and restores only the remaining hardware duration', async () => {
    await getTemperatureController().setManual('left', 76, 30 * 60_000, 600)
    const expiry = getTemperatureController().status('left').holdUntil
    const cutoff = Date.now() + 600_000
    fileDatabase.reopenForTest()
    delete (globalThis as Record<string, unknown>).__sp_temperatureController
    vi.setSystemTime(new Date('2026-09-28T22:05:00Z'))
    await getTemperatureController().reconcile('left')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 76, 300)
    expect(getTemperatureController().status('left').holdUntil).toBe(expiry)
    expect(db.select().from(deviceState).where(eq(deviceState.side, 'left')).get()?.hardwareDeadline).toBe(cutoff)
    fileDatabase.reopenForTest()
    delete (globalThis as Record<string, unknown>).__sp_temperatureController
    vi.setSystemTime(new Date('2026-09-28T22:11:00Z'))
    hardware.setTemperature.mockClear()
    await getTemperatureController().reconcile('left')
    expect(hardware.setTemperature).not.toHaveBeenCalled()
    expect(hardware.setPower).toHaveBeenLastCalledWith('left', false)
    expect(db.select().from(temperatureHolds).all()).toHaveLength(0)
    expect(db.select().from(deviceState).where(eq(deviceState.side, 'left')).get()?.isPowered).toBe(false)
  })

  it('resolves an advancing run-once session ahead of Autopilot after Resume', async () => {
    const controller = getTemperatureController()
    db.insert(runOnceSessions).values({
      side: 'left', startedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), wakeTime: '23:00',
      setPoints: JSON.stringify([{ time: '22:00', temperature: 74 }, { time: '22:10', temperature: 69 }]),
    }).run()
    await controller.setManual('left', 76)
    await controller.submit('left', {
      id: 'rule:1:0', source: 'autopilot', temperature: 70, priority: 1,
      startsAt: Date.now(), expiresAt: Date.now() + 3_600_000, createdAt: Date.now(),
    })
    vi.setSystemTime(new Date('2026-09-28T22:20:00Z'))
    const status = await controller.resume('left')
    expect(status.source).toBe('run-once')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 69)
  })

  it('keeps an explicit shutdown off through expiry and restart', async () => {
    await getTemperatureController().setManual('left', 76)
    await getTemperatureController().powerOff('left')
    hardware.setTemperature.mockClear()
    delete (globalThis as Record<string, unknown>).__sp_temperatureController
    vi.setSystemTime(new Date('2026-09-28T22:45:00Z'))
    await getTemperatureController().reconcile('left')
    expect(hardware.setTemperature).not.toHaveBeenCalled()
    expect(db.select().from(deviceState).where(eq(deviceState.side, 'left')).get()?.isPowered).toBe(false)
  })

  it('resolves schedule edits made in the same minute and handles missing device-state rows', async () => {
    const controller = getTemperatureController()
    await controller.reconcile('left')
    db.update(temperatureSchedules).set({ temperature: 71 }).where(eq(temperatureSchedules.time, '21:00')).run()
    await controller.reconcile('left')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 71)
    db.delete(deviceState).where(eq(deviceState.side, 'right')).run()
    await controller.setManual('right', 73)
    expect(db.select().from(deviceState).where(eq(deviceState.side, 'right')).get()?.targetTemperature).toBe(73)
  })

  it('expires holds automatically through the service loop', async () => {
    await getTemperatureController().setManual('left', 76, 60_000)
    await startTemperatureController()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getTemperatureController().status('left').source).toBe('schedule')
    expect(hardware.setTemperature).toHaveBeenLastCalledWith('left', 72)
  })

  it('expires the right hold while the left side lock is occupied', async () => {
    await getTemperatureController().setManual('right', 76, 1_000)
    let release = () => {}
    const holder = withSideLock('left', () => new Promise<void>((resolve) => {
      release = resolve
    }))
    await Promise.resolve()
    const starting = startTemperatureController()
    try {
      await vi.advanceTimersByTimeAsync(2_000)
      expect(db.select().from(temperatureHolds).where(eq(temperatureHolds.side, 'right')).get()).toBeUndefined()
    }
    finally {
      release()
      await holder
      await starting
    }
  })

  it('blocks both manual and scheduled energizing commands during a safety cutoff', async () => {
    safety.blocked = true
    await expect(getTemperatureController().setManual('left', 76)).rejects.toThrow('Pump stall')
    await withSideLock('left', () => getTemperatureController().reconcileLocked('left'))
    expect(hardware.setTemperature).not.toHaveBeenCalled()
    expect(db.select().from(temperatureHolds).all()).toHaveLength(0)
  })
})
