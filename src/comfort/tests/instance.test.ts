import type Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import * as schema from '@/src/db/schema'
import { defaultComfortState } from '../policy'
import { migratedComfortDatabase } from './databaseFixture'

const fixture = vi.hoisted(() => ({
  database: null as Database.Database | null,
  monitor: vi.fn(), base: vi.fn(), occupancy: vi.fn(), controller: vi.fn(), synced: true,
}))
vi.mock('@/src/db', async () => {
  const { drizzle: createDrizzle } = await import('drizzle-orm/better-sqlite3')
  const schemaModule = await import('@/src/db/schema')
  return {
    get sqlite() { return fixture.database },
    get db() {
      if (!fixture.database) throw new Error('Fixture not open')
      return createDrizzle(fixture.database, { schema: schemaModule })
    },
  }
})
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: fixture.monitor }))
vi.mock('@/src/hardware/base/instance', () => ({ getBaseControllerIfRunning: fixture.base }))
vi.mock('@/src/lib/occupancy', () => ({ getOccupancy: fixture.occupancy }))
vi.mock('@/src/temperature/instance', () => ({ getTemperatureControllerIfRunning: fixture.controller }))
vi.mock('@/src/hardware/sideMutations', () => ({ hasFirmwareSynced: () => fixture.synced }))
const { readComfortContext } = await import('../instance')
const { pauseComfortAfterManual, pendingManualPause } = await import('../manual')
const { createComfortStore } = await import('../store')
const now = Date.parse('2026-10-25T09:00:00Z')

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(now)
  vi.clearAllMocks()
  fixture.database = migratedComfortDatabase()
  fixture.synced = true
  const database = drizzle(fixture.database)
  database.insert(schema.deviceSettings).values({ timezone: 'America/Los_Angeles' }).run()
  database.insert(schema.sideSettings).values([{ side: 'left', name: 'Left' }, { side: 'right', name: 'Right' }]).run()
  database.insert(schema.deviceState).values([{ side: 'left', isPowered: true }, { side: 'right', isPowered: false }]).run()
  database.insert(schema.powerSchedules).values(DAYS_OF_WEEK.map(dayOfWeek => ({ side: 'left' as const, dayOfWeek, onTime: '22:00', offTime: '07:00', onTemperature: 75 }))).run()
  const side = { targetTemperature: 75, heatingDuration: 3600 }
  fixture.monitor.mockReturnValue({ getFreshStatus: () => ({ leftSide: side, rightSide: side, waterLevel: 'ok', isPriming: false }), getLastPollAt: () => now - 1000 })
  fixture.base.mockReturnValue({ status: () => ({ state: 'connected', stale: false, lastUpdate: now - 500, moving: false, busy: false }) })
  fixture.occupancy.mockReturnValue({ level: { ageMs: 200 }, available: true, classification: 'person' })
  fixture.controller.mockReturnValue({ status: () => ({ source: 'schedule', targetTemperature: 75 }) })
})
afterEach(() => {
  fixture.database?.close()
  vi.useRealTimers()
})

describe('live comfort input adapter', () => {
  it('uses both calibrated zones for a sole sleeper and invalidates one-zone entry evidence', () => {
    fixture.database?.prepare('UPDATE device_settings SET bed_mode = \'solo-left\', unused_zone_mode = \'follow\'').run()
    fixture.occupancy.mockImplementation((side: string) => ({
      level: { active: side === 'right', ageMs: 100, sampleAt: now - 500, sourceKey: (side === 'left' ? 'a' : 'b').repeat(64) },
      available: true, classification: side === 'right' ? 'person' : 'none',
    }))
    const presence = readComfortContext('left', defaultComfortState(), now).context.presence
    expect(presence).toMatchObject({ occupied: true, available: true, entry: { state: 'present', measuredAt: now - 500 } })
    expect(presence.entry?.sourceKey).not.toBe('a'.repeat(64))
    expect(fixture.occupancy.mock.calls.map(call => call[0])).toEqual(['left', 'right'])
  })

  it('binds bed-entry evidence to calibrated level samples, never residual movement alone', () => {
    const level = { active: true, ageMs: 200, sampleAt: now - 2000, sourceKey: 'a'.repeat(64) }
    fixture.occupancy.mockReturnValue({ level, available: true, classification: 'person' })
    expect(readComfortContext('left', defaultComfortState(), now).context.presence.entry).toEqual({ measuredAt: now - 2000, sourceKey: level.sourceKey, state: 'present' })
    fixture.occupancy.mockReturnValue({ level: { ...level, active: false }, available: true, classification: 'person' })
    expect(readComfortContext('left', defaultComfortState(), now).context.presence.entry?.state).toBe('unknown')
    fixture.occupancy.mockReturnValue({ level: { ...level, active: false }, available: true, classification: 'none' })
    expect(readComfortContext('left', defaultComfortState(), now).context.presence.entry?.state).toBe('absent')
    fixture.occupancy.mockReturnValue({ level: { ageMs: 200 }, available: false, classification: 'person' })
    expect(readComfortContext('left', defaultComfortState(), now).context.presence.entry).toBeUndefined()
  })

  it('does not treat an unconfigured base as confirmed absent', () => {
    fixture.base.mockReturnValue({ status: () => ({ state: 'unconfigured' }) })
    expect(readComfortContext('left', defaultComfortState(), now).context.device.baseMoving).toBeNull()
  })

  it('reads current reported targets, sensor age, routine and shared ownership without creating hardware', () => {
    expect(readComfortContext('left', defaultComfortState(), now)).toMatchObject({
      timezone: 'America/Los_Angeles', context: {
        window: { baselineF: 75 }, owner: 'schedule', targetKnown: true,
        device: { observedAt: now - 1000, powered: true, waterAdequate: true, baseMoving: false, targetF: 75 },
        presence: { observedAt: now - 200, available: true, occupied: true },
      },
    })
  })

  it('makes missing/future device data and base motion explicitly unavailable', () => {
    fixture.monitor.mockReturnValue({ getFreshStatus: () => null, getLastPollAt: () => now + 1 })
    fixture.base.mockReturnValue(null)
    expect(readComfortContext('left', defaultComfortState(), now).context.device).toMatchObject({ observedAt: null, powered: false, waterAdequate: null, baseMoving: null, targetF: null })
  })

  it('never trusts persisted powered state before the first firmware report', () => {
    fixture.synced = false
    expect(readComfortContext('left', defaultComfortState(), now).context.device.powered).toBe(false)
  })

  it('uses either-side vibration and requires calibrated person presence', () => {
    fixture.database?.prepare('UPDATE device_state SET is_alarm_vibrating = 1 WHERE side = \'right\'').run()
    fixture.occupancy.mockReturnValue({ level: { ageMs: 90_001 }, available: false, classification: 'light' })
    expect(readComfortContext('left', defaultComfortState(), now).context).toMatchObject({ device: { vibrating: true }, presence: { occupied: false, available: false } })
  })

  it('applies a wake window longer than thirty minutes and reflects edits within the minute', () => {
    if (!fixture.database) throw new Error('Fixture not open')
    drizzle(fixture.database).insert(schema.alarmSchedules).values({ side: 'left', dayOfWeek: 'sunday', time: '03:00', vibrationIntensity: 50, duration: 30, alarmTemperature: 80, wakeWindow: 90 }).run()
    expect(readComfortContext('left', defaultComfortState(), now).context.alarmOverride).toBe(true)
    fixture.database.prepare('UPDATE power_schedules SET on_temperature = 77').run()
    expect(readComfortContext('left', defaultComfortState(), now).context.window?.baselineF).toBe(77)
  })

  it('journals manual intent, and does not throw when storage fails', () => {
    if (!fixture.database) throw new Error('Fixture not open')
    pauseComfortAfterManual('left')
    expect(createComfortStore(fixture.database).read('left').pausedUntil).toBe(now + 6 * 3_600_000)
    fixture.database.exec('CREATE TRIGGER reject_comfort BEFORE INSERT ON comfort_events BEGIN SELECT RAISE(ABORT, \'test\'); END')
    expect(() => pauseComfortAfterManual('right')).not.toThrow()
    expect(pendingManualPause('right')).toBe(now)
    fixture.database.exec('DROP TRIGGER reject_comfort')
    pauseComfortAfterManual('right')
    expect(pendingManualPause('right')).toBeNull()
  })
})
