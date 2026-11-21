import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockSetAlarm = vi.fn().mockResolvedValue(undefined)
const mockBroadcastMutationStatus = vi.fn()
// The alarm each side was last marked ringing with (what getActiveAlarmConfig returns).
const ringing = new Map<string, unknown>()
const mockMarkAlarmStarted = vi.fn(async (side: string, config: unknown) => {
  ringing.set(side, config)
})

vi.mock('../alarmState', () => ({
  markAlarmStarted: (...args: [string, unknown]) => mockMarkAlarmStarted(...args),
  getActiveAlarmConfig: (side: string) => ringing.get(side) ?? null,
}))

vi.mock('../dacMonitor.instance', () => ({
  getSharedHardwareClient: vi.fn(() => ({
    setAlarm: mockSetAlarm,
  })),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: mockBroadcastMutationStatus,
}))

// Who is in bed when a snooze restarts. Default: right is away, so left sleeps alone.
const mockReadAwayModes = vi.fn()
vi.mock('../awayModes', () => ({
  readAwayModes: () => mockReadAwayModes(),
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
    ringing.clear()
    mockSetAlarm.mockClear()
    mockSetAlarm.mockResolvedValue(undefined)
    mockBroadcastMutationStatus.mockClear()
    mockReadAwayModes.mockReset().mockResolvedValue({ right: { awayMode: true } })
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

    // Comes back as it was, counting the snooze (for Snooze taper).
    expect(mockSetAlarm).toHaveBeenCalledWith('left', { ...config, snoozeCount: 1 })
    // Recorded as vibrating (so a tap can snooze it again), not just broadcast.
    expect(mockMarkAlarmStarted).toHaveBeenCalledWith('left', { ...config, snoozeCount: 1 })
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

    expect(mockSetAlarm).toHaveBeenCalledWith('left', { ...config2, snoozeCount: 1 })
    expect(mockSetAlarm).toHaveBeenCalledTimes(1)
  })

  it('brings a linked alarm (single sleeper) back on both sides', async () => {
    const solo = { ...config, linkedSide: 'right' as const, ownerSide: 'left' as const }
    snoozeAlarm('left', 60, { ...solo, linkId: 'first' })
    await vi.advanceTimersByTimeAsync(60_000)
    // It comes back as a new occurrence, one id on both sides.
    const linkId = (mockSetAlarm.mock.calls[0][1] as { linkId: string }).linkId
    expect(linkId).toEqual(expect.any(String))
    expect(linkId).not.toBe('first')
    expect(mockSetAlarm.mock.calls).toEqual([
      ['left', { ...solo, snoozeCount: 1, linkId }],
      ['right', { ...solo, snoozeCount: 1, linkedSide: 'left', linkId }],
    ])
    expect(mockMarkAlarmStarted).toHaveBeenCalledWith('right', { ...solo, snoozeCount: 1, linkedSide: 'left', linkId })
  })

  it('rings only the owner when the partner came back during the snooze', async () => {
    const solo = { ...config, linkedSide: 'right' as const, ownerSide: 'left' as const, linkId: 'first' }
    snoozeAlarm('left', 60, solo)
    mockReadAwayModes.mockResolvedValue({ left: { awayMode: false }, right: { awayMode: false } })
    await vi.advanceTimersByTimeAsync(60_000)
    // Comes back unlinked: stopping or snoozing it no longer reaches right.
    expect(mockSetAlarm.mock.calls).toEqual([['left', { ...config, snoozeCount: 1 }]])
    expect(mockMarkAlarmStarted.mock.calls).toEqual([['left', { ...config, snoozeCount: 1 }]])
  })

  it('brings a snooze tapped on the unused side back on the owner\'s side first', async () => {
    // Tapped on the unused right side: recorded there, linked to left.
    snoozeAlarm('right', 60, { ...config, linkedSide: 'left', ownerSide: 'left' })
    await vi.advanceTimersByTimeAsync(60_000)
    const linkId = (mockSetAlarm.mock.calls[0][1] as { linkId: string }).linkId
    expect(mockSetAlarm.mock.calls).toEqual([
      ['left', { ...config, snoozeCount: 1, linkedSide: 'right', ownerSide: 'left', linkId }],
      ['right', { ...config, snoozeCount: 1, linkedSide: 'left', ownerSide: 'left', linkId }],
    ])
  })

  it('does not ring the unused side it was tapped on once the partner is back', async () => {
    snoozeAlarm('right', 60, { ...config, linkedSide: 'left', ownerSide: 'left' })
    mockReadAwayModes.mockResolvedValue({})
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockSetAlarm.mock.calls).toEqual([['left', { ...config, snoozeCount: 1 }]])
  })

  it('rings only the owner when the away modes can\'t be read', async () => {
    const failure = new Error('db locked')
    mockReadAwayModes.mockRejectedValue(failure)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    snoozeAlarm('left', 60, { ...config, linkedSide: 'right', ownerSide: 'left' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(error).toHaveBeenCalledWith('[Snooze] Failed to read away modes; restarting left only:', failure)
    expect(mockSetAlarm.mock.calls).toEqual([['left', { ...config, snoozeCount: 1 }]])
    error.mockRestore()
  })

  it('gives an unlinked alarm no occurrence id', async () => {
    snoozeAlarm('left', 60, config)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockSetAlarm).toHaveBeenCalledWith('left', { ...config, snoozeCount: 1 })
  })

  it('replaces a linked snooze taken on the other side when this side snoozes', async () => {
    // Tapped on the unused right side, then snoozed from HomeKit on left.
    snoozeAlarm('right', 60, { ...config, linkedSide: 'left', ownerSide: 'left' })
    snoozeAlarm('left', 120, config)
    expect(getSnoozeStatus('right').active).toBe(false)
    expect(loadAlarmState().snoozes.right).toBeUndefined()
    await vi.advanceTimersByTimeAsync(120_000)
    // Only the new snooze restarts the alarm, once.
    expect(mockSetAlarm.mock.calls).toEqual([['left', { ...config, snoozeCount: 1 }]])
  })

  it('leaves the other side\'s unlinked snooze running when this side snoozes', () => {
    snoozeAlarm('right', 60, config)
    snoozeAlarm('left', 60, config)
    expect(getSnoozeStatus('right').active).toBe(true)
  })

  it('cancels a linked snooze taken on the other side when either side is stopped', async () => {
    // Tapped on the unused right side: the snooze is recorded there only.
    snoozeAlarm('right', 60, { ...config, linkedSide: 'left', ownerSide: 'left' })
    cancelSnooze('left')
    expect(getSnoozeStatus('right').active).toBe(false)
    expect(loadAlarmState().snoozes.right).toBeUndefined()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockSetAlarm).not.toHaveBeenCalled()
  })

  it('leaves the other side\'s unlinked snooze alone', () => {
    snoozeAlarm('right', 60, config)
    cancelSnooze('left')
    expect(getSnoozeStatus('right').active).toBe(true)
  })

  it('skips the other side when the alarm was stopped before it rang there', async () => {
    const solo = { ...config, linkedSide: 'right' as const, ownerSide: 'left' as const }
    // Stopped right after it came back on the snoozed side.
    mockMarkAlarmStarted.mockImplementationOnce(async () => {
      ringing.delete('left')
    })
    snoozeAlarm('left', 60, solo)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockSetAlarm.mock.calls.map(([side]) => side)).toEqual(['left'])
  })

  it('counts each snooze of the same alarm', async () => {
    snoozeAlarm('left', 60, { ...config, snoozeCount: 2 })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mockMarkAlarmStarted).toHaveBeenCalledWith('left', { ...config, snoozeCount: 3 })
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
      expect(loadAlarmState().snoozes.left).toEqual({ until: 310_000, config: { ...config, snoozeCount: 1 } })
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

    it('a restored linked snooze rings only the owner once the partner is back', async () => {
      vi.setSystemTime(0)
      const solo = { ...config, linkedSide: 'right' as const, ownerSide: 'left' as const, linkId: 'first' }
      updateAlarmState((s) => {
        s.snoozes.left = { until: 60_000, config: solo }
      })
      mockReadAwayModes.mockResolvedValue({ bedMode: 'two' })
      restoreSnoozes()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(mockSetAlarm.mock.calls).toEqual([['left', config]])
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
