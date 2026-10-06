import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  writes: [] as Array<{ isAlarmVibrating: boolean }>,
  fail: false,
  failure: new Error('db dead') as unknown,
  broadcast: vi.fn(),
}))

vi.mock('@/src/db', () => ({
  db: {
    update: () => ({
      set: (values: { isAlarmVibrating: boolean }) => ({
        where: async () => {
          if (mocks.fail) throw mocks.failure
          mocks.writes.push(values)
        },
      }),
    }),
  },
}))
vi.mock('@/src/streaming/broadcastMutationStatus', () => ({ broadcastMutationStatus: mocks.broadcast }))

const { getActiveAlarmConfig, markAlarmEnded, markAlarmStarted, restoreActiveAlarms, suspendActiveAlarms } = await import('../alarmState')
const { loadAlarmState, resetAlarmStateCache, updateAlarmState } = await import('../alarmPersistence')

const ALARM = { vibrationIntensity: 100, vibrationPattern: 'rise' as const, duration: 120 }

describe('alarmState', () => {
  let dir: string

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'alarm-state-'))
    process.env.ALARM_STATE_PATH = join(dir, 'alarm-state.json')
    resetAlarmStateCache()
    mocks.writes.length = 0
    mocks.fail = false
    mocks.failure = new Error('db dead')
    mocks.broadcast.mockClear()
  })

  afterEach(() => {
    suspendActiveAlarms()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  it('records a started alarm as vibrating, with its settings', async () => {
    await markAlarmStarted('left', ALARM, 1_000)
    expect(mocks.writes.at(-1)).toMatchObject({ isAlarmVibrating: true })
    expect(mocks.broadcast).toHaveBeenCalledWith('left', { isAlarmVibrating: true })
    expect(getActiveAlarmConfig('left')).toEqual(ALARM)
    expect(getActiveAlarmConfig('right')).toBeNull()
    expect(loadAlarmState().alarms.left).toEqual({ until: 1_000 + 120_000, config: ALARM })
  })

  it('ends by itself when its duration runs out', async () => {
    await markAlarmStarted('right', ALARM)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(getActiveAlarmConfig('right')).toEqual(ALARM)
    await vi.advanceTimersByTimeAsync(1)
    expect(getActiveAlarmConfig('right')).toBeNull()
    expect(mocks.writes.at(-1)).toMatchObject({ isAlarmVibrating: false })
    expect(mocks.broadcast).toHaveBeenLastCalledWith('right', { isAlarmVibrating: false })
    expect(loadAlarmState().alarms.right).toBeUndefined()
  })

  it('ends early when stopped, and the duration timer no longer fires', async () => {
    await markAlarmStarted('left', ALARM)
    await markAlarmEnded('left')
    expect(getActiveAlarmConfig('left')).toBeNull()
    expect(mocks.writes.at(-1)).toMatchObject({ isAlarmVibrating: false })
    mocks.broadcast.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.broadcast).not.toHaveBeenCalled()
  })

  it('a new alarm replaces the running one and its end time', async () => {
    await markAlarmStarted('left', ALARM)
    await vi.advanceTimersByTimeAsync(100_000)
    await markAlarmStarted('left', { ...ALARM, duration: 60 })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(getActiveAlarmConfig('left')).toEqual({ ...ALARM, duration: 60 })
    await vi.advanceTimersByTimeAsync(1)
    expect(getActiveAlarmConfig('left')).toBeNull()
  })

  it('logs a failed store and still broadcasts', async () => {
    mocks.fail = true
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await markAlarmStarted('left', ALARM)
    expect(err).toHaveBeenCalledWith('[alarmState] failed to store alarm state for left:', 'db dead')
    expect(mocks.broadcast).toHaveBeenCalledWith('left', { isAlarmVibrating: true })
    err.mockRestore()
  })

  it('broadcasts and retains the active alarm after a non-Error store failure', async () => {
    mocks.fail = true
    mocks.failure = { code: 'SQLITE_BUSY' }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await markAlarmStarted('right', ALARM)
      expect(error).toHaveBeenCalledExactlyOnceWith('[alarmState] failed to store alarm state for right:', mocks.failure)
      expect(mocks.broadcast).toHaveBeenCalledExactlyOnceWith('right', { isAlarmVibrating: true })
      expect(getActiveAlarmConfig('right')).toEqual(ALARM)
      expect(loadAlarmState().alarms.right?.config).toEqual(ALARM)
    }
    finally {
      error.mockRestore()
    }
  })

  describe('restoreActiveAlarms', () => {
    it('resumes an alarm still within its duration', async () => {
      updateAlarmState((s) => {
        s.alarms.left = { until: 50_000, config: ALARM }
      })
      await restoreActiveAlarms(20_000)
      expect(getActiveAlarmConfig('left')).toEqual(ALARM)
      expect(mocks.broadcast).toHaveBeenCalledWith('left', { isAlarmVibrating: true })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(getActiveAlarmConfig('left')).toBeNull()
    })

    it('clears a flag left set by a process that stopped mid-alarm', async () => {
      updateAlarmState((s) => {
        s.alarms.right = { until: 10_000, config: ALARM }
      })
      await restoreActiveAlarms(20_000)
      expect(getActiveAlarmConfig('right')).toBeNull()
      expect(mocks.broadcast).toHaveBeenCalledWith('right', { isAlarmVibrating: false })
      expect(mocks.broadcast).toHaveBeenCalledWith('left', { isAlarmVibrating: false })
      expect(loadAlarmState().alarms).toEqual({})
    })
  })

  it('suspending stops timers but keeps the alarm on disk for the next process', async () => {
    await markAlarmStarted('left', ALARM, Date.now())
    suspendActiveAlarms()
    expect(getActiveAlarmConfig('left')).toBeNull()
    mocks.broadcast.mockClear()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(mocks.broadcast).not.toHaveBeenCalled()
    expect(loadAlarmState().alarms.left).toBeDefined()
  })
})
