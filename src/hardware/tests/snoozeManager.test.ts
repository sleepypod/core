import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSetAlarm = vi.fn().mockResolvedValue(undefined)
const mockBroadcastMutationStatus = vi.fn()

vi.mock('../dacMonitor.instance', () => ({
  getSharedHardwareClient: vi.fn(() => ({
    setAlarm: mockSetAlarm,
  })),
}))

vi.mock('@/src/streaming/broadcastMutationStatus', () => ({
  broadcastMutationStatus: mockBroadcastMutationStatus,
}))

import { snoozeAlarm, cancelSnooze, getSnoozeStatus } from '../snoozeManager'

describe('snoozeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSetAlarm.mockClear()
    mockSetAlarm.mockResolvedValue(undefined)
    mockBroadcastMutationStatus.mockClear()
    cancelSnooze('left')
    cancelSnooze('right')
  })

  afterEach(() => {
    vi.useRealTimers()
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
    expect(mockBroadcastMutationStatus).toHaveBeenCalledWith('left', { isAlarmVibrating: true })
    expect(getSnoozeStatus('left')).toEqual({ active: false, snoozeUntil: null })
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
    expect(mockBroadcastMutationStatus).not.toHaveBeenCalled()
    expect(getSnoozeStatus('right').active).toBe(false)
    error.mockRestore()
  })
})
