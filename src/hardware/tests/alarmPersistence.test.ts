import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alarmStatePath, loadAlarmState, resetAlarmStateCache, updateAlarmState } from '../alarmPersistence'

const ALARM = { vibrationIntensity: 100, vibrationPattern: 'rise' as const, duration: 120 }

describe('alarmPersistence', () => {
  let dir: string
  const saved = { ...process.env }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'alarm-state-'))
    process.env.ALARM_STATE_PATH = join(dir, 'alarm-state.json')
    resetAlarmStateCache()
  })

  afterEach(() => {
    process.env = { ...saved }
    resetAlarmStateCache()
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('lives next to the database unless ALARM_STATE_PATH says otherwise', () => {
    delete process.env.ALARM_STATE_PATH
    process.env.DATABASE_URL = 'file:/persistent/sleepypod-data/sleepypod.db'
    expect(alarmStatePath()).toBe('/persistent/sleepypod-data/alarm-state.json')
    process.env.ALARM_STATE_PATH = '/tmp/x.json'
    expect(alarmStatePath()).toBe('/tmp/x.json')
  })

  it.each([undefined, ''])('uses the local default when DATABASE_URL is %s', (url) => {
    delete process.env.ALARM_STATE_PATH
    if (url === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = url
    expect(alarmStatePath()).toBe('alarm-state.json')
  })

  it('logs non-Error serialization failures and retains the change in memory', () => {
    const failure = { reason: 'serialization failed' }
    const config = {
      ...ALARM,
      toJSON() { throw failure },
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateAlarmState((s) => {
      s.alarms.right = { until: 2_000, config }
    })
    expect(error).toHaveBeenCalledExactlyOnceWith('[alarmState] failed to persist alarm state:', failure)
    expect(loadAlarmState().alarms.right).toEqual({ until: 2_000, config })
  })

  it('starts empty without a file', () => {
    expect(loadAlarmState()).toEqual({ alarms: {}, snoozes: {} })
  })

  it('writes every change and reads it back in a new process', () => {
    updateAlarmState((s) => {
      s.snoozes.left = { until: 1_000, config: ALARM }
    })
    updateAlarmState((s) => {
      s.alarms.right = { until: 2_000, config: ALARM }
    })
    const onDisk = JSON.parse(readFileSync(process.env.ALARM_STATE_PATH as string, 'utf8'))
    expect(onDisk).toEqual({ alarms: { right: { until: 2_000, config: ALARM } }, snoozes: { left: { until: 1_000, config: ALARM } } })
    resetAlarmStateCache()
    expect(loadAlarmState()).toEqual(onDisk)
  })

  it('ignores a malformed file and malformed entries', () => {
    writeFileSync(process.env.ALARM_STATE_PATH as string, '{"snoozes":{"left":{"until":"soon"},"right":{"until":5,"config":{"vibrationIntensity":50,"vibrationPattern":"buzz","duration":60}}}}')
    expect(loadAlarmState()).toEqual({ alarms: {}, snoozes: {} })
    resetAlarmStateCache()
    writeFileSync(process.env.ALARM_STATE_PATH as string, 'not json')
    expect(loadAlarmState()).toEqual({ alarms: {}, snoozes: {} })
  })

  it('logs a failed write and keeps the in-memory state', () => {
    process.env.ALARM_STATE_PATH = join(dir, 'missing', '\0bad', 'alarm-state.json')
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    updateAlarmState((s) => {
      s.snoozes.left = { until: 1_000, config: ALARM }
    })
    expect(err).toHaveBeenCalledWith('[alarmState] failed to persist alarm state:', expect.any(String))
    expect(loadAlarmState().snoozes.left).toEqual({ until: 1_000, config: ALARM })
    err.mockRestore()
  })
})
