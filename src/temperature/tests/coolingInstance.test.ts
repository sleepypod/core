// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { migratedComfortDatabase } from '@/src/comfort/tests/databaseFixture'
import { coolingProposal } from '../cooling'
const runtime = vi.hoisted(() => ({ database: null as Database.Database | null, at: 0, connected: true, fresh: true,
  status: { waterLevel: 'ok', isPriming: false, leftSide: { heatingDuration: 28800 }, rightSide: { heatingDuration: 28800 } } }))
vi.mock('@/src/db', () => ({
  get sqlite() { return runtime.database },
}))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getSharedHardwareClient: () => ({ isConnected: () => runtime.connected }),
  getDacMonitorIfRunning: () => ({ getStatus: () => 'running', getLastPollAt: () => runtime.at,
    getLastStatus: () => runtime.status, getFreshStatus: () => runtime.fresh ? runtime.status : null }),
}))
import { readCoolingContext } from '../coolingInstance'
let database: Database.Database
const now = Date.parse('2026-11-11T06:20:00Z')
beforeEach(() => {
  database = migratedComfortDatabase()
  runtime.database = database
  runtime.at = now
  runtime.connected = true
  runtime.fresh = true
  runtime.status = { waterLevel: 'ok', isPriming: false, leftSide: { heatingDuration: 28800 }, rightSide: { heatingDuration: 28800 } }
  database.prepare('INSERT INTO device_settings (id,timezone,bed_mode,unused_zone_mode) VALUES (1,\'UTC\',\'solo-left\',\'follow\')').run()
  database.prepare('INSERT INTO side_settings (side,name) VALUES (\'left\',\'Luca\'),(\'right\',\'Right\')').run()
  database.prepare('INSERT INTO alarm_schedules (side,day_of_week,time,enabled,duration,alarm_temperature,wake_window,vibration_intensity,vibration_pattern) VALUES (\'left\',\'wednesday\',\'07:00\',1,20,105,0,50,\'rise\')').run()
})
afterEach(() => database.close())
describe('production temporary cooling evidence', () => {
  it('uses the solo source wake plan for both physical zones without assigning a person', () => {
    const left = readCoolingContext('left', now)
    const right = readCoolingContext('right', now)
    expect(left.wakeStartsAt).toBe(Date.parse('2026-11-11T06:30:00Z'))
    expect(right.wakeStartsAt).toBe(left.wakeStartsAt)
    expect(right.scope).not.toBe(left.scope)
    expect(left.sessionEndsAt).toBe(now + 28800_000)
    expect(coolingProposal(right, 70, now)?.expiresAt).toBe(left.wakeStartsAt)
    expect(database.prepare('SELECT count(*) AS count FROM comfort_moments').get()).toEqual({ count: 0 })
  })
  it('changes scope when arrangement changes and refuses a disconnected, stale, priming or empty Pod', () => {
    const original = readCoolingContext('left', now)
    database.prepare('UPDATE device_settings SET bed_mode=\'two\'').run()
    expect(readCoolingContext('left', now).scope).not.toBe(original.scope)
    runtime.connected = false
    expect(readCoolingContext('left', now).available).toBe(false)
    runtime.connected = true
    runtime.fresh = false
    expect(coolingProposal(readCoolingContext('left', now), 70, now)).toBeNull()
    runtime.fresh = true
    runtime.status.isPriming = true
    expect(readCoolingContext('left', now).available).toBe(false)
    runtime.status.isPriming = false
    runtime.status.waterLevel = 'low'
    expect(readCoolingContext('left', now).available).toBe(false)
  })
  it('refuses active wake warming and unknown countdowns but permits a known alarm-free night', () => {
    runtime.at = now + 10 * 60_000
    expect(coolingProposal(readCoolingContext('left', runtime.at), 70, runtime.at)).toBeNull()
    database.prepare('DELETE FROM alarm_schedules').run()
    expect(coolingProposal(readCoolingContext('left', runtime.at), 70, runtime.at)).not.toBeNull()
    runtime.status.leftSide.heatingDuration = 0
    expect(coolingProposal(readCoolingContext('left', runtime.at), 70, runtime.at)).toBeNull()
  })
})
