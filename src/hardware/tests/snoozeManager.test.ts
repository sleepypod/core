import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockSetAlarm = vi.fn().mockResolvedValue(undefined)

// Mock piezoStream before dacMonitor.instance — Vitest's import analysis
// resolves the dynamic import("@/src/streaming/piezoStream") in dacMonitor.instance.ts
// even when the module itself is mocked.
vi.mock('@/src/streaming/piezoStream', () => ({
  broadcastFrame: vi.fn(),
}))

vi.mock('../dacMonitor.instance', () => ({
  getSharedHardwareClient: vi.fn(() => ({
    setAlarm: mockSetAlarm,
  })),
}))

import { snoozeAlarm, cancelSnooze, getSnoozeStatus } from '../snoozeManager'

describe('snoozeManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSetAlarm.mockClear()
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
    snoozeAlarm('left', 300, config)
    const status = getSnoozeStatus('left')
    expect(status.active).toBe(true)
    expect(status.snoozeUntil).toBeTypeOf('number')
  })

  it('does not affect other side', () => {
    snoozeAlarm('left', 300, config)
    expect(getSnoozeStatus('right').active).toBe(false)
  })

  it('re-triggers alarm after timeout expires', async () => {
    snoozeAlarm('left', 300, config)
    vi.advanceTimersByTime(300_000)
    await vi.runAllTimersAsync()

    expect(mockSetAlarm).toHaveBeenCalledWith('left', config)
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
})
