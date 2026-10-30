// @vitest-environment node
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { recordMechanicalCommand } from '../dispatch'
import { MechanicalStore } from '../store'

const fixture = vi.hoisted(() => ({ database: null as Database.Database | null,
  alarms: [{ side: 'left', isAlarmVibrating: false }, { side: 'right', isAlarmVibrating: false }],
  deviceAvailable: true, baseAvailable: true }))
vi.mock('@/src/db', () => ({ biometricsDb: { get $client() {
  return fixture.database
} },
db: { select: () => ({ from: () => ({ all: () => fixture.alarms }) }) } }))
vi.mock('@/src/hardware/dacMonitor.instance', () => ({ getDacMonitorIfRunning: () => ({
  getFreshStatus: () => fixture.deviceAvailable ? { isPriming: false } : null,
  getLastPollAt: () => Date.now(),
}) }))
vi.mock('@/src/hardware/base/instance', () => ({ getBaseControllerIfRunning: () => ({ status: () => ({
  state: fixture.baseAvailable ? 'connected' : 'unconfigured', stale: !fixture.baseAvailable,
  moving: fixture.baseAvailable ? false : null, busy: false, lastUpdate: Date.now(),
}) }) }))

it('runs the production observer lifecycle with missing telemetry and command-derived alarm state', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1700000000000)
  const database = new Database(':memory:')
  database.exec(readFileSync(new URL('../../../db/biometrics-migrations/0032_mechanical_signal_context.sql', import.meta.url), 'utf8'))
  fixture.database = database
  const { startMechanicalContext, stopMechanicalContext } = await import('../instance')
  const read = () => new MechanicalStore(database).read()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    startMechanicalContext()
    startMechanicalContext()
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(11000)
    expect(read()?.reasons).toEqual([])
    fixture.baseAvailable = false
    vi.advanceTimersByTime(1000)
    expect(read()?.reasons).toContain('base_unavailable')
    fixture.baseAvailable = true
    fixture.alarms[0].isAlarmVibrating = true
    vi.advanceTimersByTime(1000)
    expect(read()?.reasons).toContain('vibration_command')
    fixture.alarms[0].isAlarmVibrating = false
    fixture.deviceAvailable = false
    vi.advanceTimersByTime(1000)
    expect(read()?.reasons).toContain('device_unavailable')
    fixture.deviceAvailable = true
    vi.advanceTimersByTime(11000)
    expect(read()?.reasons).toEqual([])
    recordMechanicalCommand('vibration', 180000)
    expect(read()?.spanId).toBeNull()
    stopMechanicalContext()
    expect(read()?.reasons).toEqual(['controller_stopped'])
    expect(vi.getTimerCount()).toBe(0)
    expect(() => recordMechanicalCommand('priming')).toThrow('stopped')
    expect(() => recordMechanicalCommand('vibration', 0, true)).not.toThrow()
  }
  finally {
    stopMechanicalContext()
    const globals = globalThis as Record<string, unknown>
    delete globals.__sp_mechanicalRuntime
    delete globals.__sp_mechanicalObserver
    database.close()
    warning.mockRestore()
    vi.useRealTimers()
  }
})
