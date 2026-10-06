import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockSetAlarm = vi.fn().mockResolvedValue(undefined)
const mockBroadcastMutationStatus = vi.fn()
const mockMarkAlarmStarted = vi.fn().mockResolvedValue(undefined)

vi.mock('../alarmState', () => ({
  markAlarmStarted: (...args: unknown[]) => mockMarkAlarmStarted(...args),
}))

vi.mock('../dacMonitor.instance', () => ({
  getSharedHardwareClient: vi.fn(() => ({
    setAlarm: mockSetAlarm,
  })),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: mockBroadcastMutationStatus,
}))

import { snoozeAlarm, cancelSnooze, getSnoozeStatus, restoreSnoozes, suspendSnoozes, SNOOZE_LATE_GRACE_MS } from '../snoozeManager'
import { loadAlarmState, resetAlarmStateCache, updateAlarmState } from '../alarmPersistence'

describe('snoozeManager', () => {
  let dir: string

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'snooze-'))
    process.env.ALARM_STATE_PATH = join(dir, 'alarm-state.json')
    resetAlarmStateCache()
    mockMarkAlarmStarted.mockClear()
    mockSetAlarm.mockClear()
    mockSetAlarm.mockResolvedValue(undefined)
    mockBroadcastMutationStatus.mockClear()
    cancelSnooze('left')
    cancelSnooze('right')
  })

  afterEach(() => {
    suspendSnoozes()
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const config = { vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 120 }

  it('reports no active snooze initially', () => {
    const status = getSnoozeStatus('left')
    expect(status.active).toBe(false)
    expect(status.snoozeUntil).toBeNull()
  })

  it('sets active snooze with correct expiry', () => {
    vi.setSystemTime(new Date('2026-07-20T01:00:00.900Z'))
    const until = snoozeAlarm('left', 300, config)
    const status = getSnoozeStatus('left')
    expect(status.active).toBe(true)
    expect(until.toISOString()).toBe('2026-07-20T01:05:00.900Z')
    expect(status.snoozeUntil).toBe(1_784_509_500)
  })

  it('does not affect other side', () => {
    snoozeAlarm('left', 300, config)
    expect(getSnoozeStatus('right').active).toBe(false)
  })

  it('re-triggers alarm after timeout expires', async () => {
    snoozeAlarm('left', 300, config)
    await vi.advanceTimersByTimeAsync(299_999)
    expect(mockSetAlarm).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)

    expect(mockSetAlarm).toHaveBeenCalledWith('left', config)
    // Recorded as vibrating (so a tap can snooze it again), not just broadcast.
    expect(mockMarkAlarmStarted).toHaveBeenCalledWith('left', config)
    expect(getSnoozeStatus('left')).toEqual({ active: false, snoozeUntil: null })
    expect(loadAlarmState().snoozes.left).toBeUndefined()
  })

  it('cancelSnooze prevents re-trigger', async () => {
    snoozeAlarm('left', 300, config)
    cancelSnooze('left')

    expect(getSnoozeStatus('left').active).toBe(false)

    vi.advanceTimersByTime(300_000)
    await vi.runAllTimersAsync()

    expect(mockSetAlarm).not.toHaveBeenCalled()
  })

  it('second snooze replaces first', async () => {
    const config2 = { vibrationIntensity: 80, vibrationPattern: 'double' as const, duration: 60 }
    snoozeAlarm('left', 300, config)
    snoozeAlarm('left', 60, config2)

    vi.advanceTimersByTime(60_000)
    await vi.runAllTimersAsync()

    expect(mockSetAlarm).toHaveBeenCalledWith('left', config2)
    expect(mockSetAlarm).toHaveBeenCalledTimes(1)
  })

  it('clamps delays to the signed 32-bit setTimeout ceiling', () => {
    vi.setSystemTime(0)
    const maxSeconds = Math.floor((2 ** 31 - 1) / 1000)

    const until = snoozeAlarm('right', Number.MAX_SAFE_INTEGER, config)

    expect(until.getTime()).toBe(maxSeconds * 1000)
    expect(getSnoozeStatus('right')).toEqual({ active: true, snoozeUntil: maxSeconds })
    expect(vi.getTimerCount()).toBe(1)
  })

  it('logs a failed restart and does not broadcast a false success', async () => {
    const failure = new Error('motor offline')
    mockSetAlarm.mockRejectedValueOnce(failure)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    snoozeAlarm('right', 4, config)

    await vi.advanceTimersByTimeAsync(4_000)

    expect(error).toHaveBeenCalledWith('[Snooze] Failed to restart alarm for right:', failure)
    expect(mockMarkAlarmStarted).not.toHaveBeenCalled()
    expect(getSnoozeStatus('right').active).toBe(false)
    error.mockRestore()
  })

  describe('persistence', () => {
    it('keeps a pending snooze on disk until it fires or is cancelled', async () => {
      vi.setSystemTime(10_000)
      snoozeAlarm('left', 300, config)
      expect(loadAlarmState().snoozes.left).toEqual({ until: 310_000, config })
      cancelSnooze('left')
      expect(loadAlarmState().snoozes.left).toBeUndefined()
    })

    it('a restarted process resumes a pending snooze at its original time', async () => {
      vi.setSystemTime(0)
      updateAlarmState((s) => {
        s.snoozes.right = { until: 300_000, config }
      })
      vi.setSystemTime(120_000)
      restoreSnoozes()
      expect(getSnoozeStatus('right')).toEqual({ active: true, snoozeUntil: 300 })
      await vi.advanceTimersByTimeAsync(179_999)
      expect(mockSetAlarm).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(mockSetAlarm).toHaveBeenCalledWith('right', config)
    })

    it('fires at once a snooze missed by a short outage', async () => {
      updateAlarmState((s) => {
        s.snoozes.left = { until: 100_000, config }
      })
      restoreSnoozes(100_000 + SNOOZE_LATE_GRACE_MS)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockSetAlarm).toHaveBeenCalledWith('left', config)
    })

    it('drops a snooze missed by longer than the grace period', async () => {
      updateAlarmState((s) => {
        s.snoozes.left = { until: 100_000, config }
      })
      restoreSnoozes(100_001 + SNOOZE_LATE_GRACE_MS)
      await vi.runAllTimersAsync()
      expect(mockSetAlarm).not.toHaveBeenCalled()
      expect(getSnoozeStatus('left').active).toBe(false)
      expect(loadAlarmState().snoozes.left).toBeUndefined()
    })

    it('suspending at shutdown keeps the snooze for the next process', async () => {
      snoozeAlarm('right', 300, config)
      suspendSnoozes()
      expect(getSnoozeStatus('right').active).toBe(false)
      await vi.runAllTimersAsync()
      expect(mockSetAlarm).not.toHaveBeenCalled()
      expect(loadAlarmState().snoozes.right).toBeDefined()
    })
  })
})
