/**
 * Tests for broadcastMutationStatus — the mutation-driven WS overlay broadcast.
 *
 * All hardware/streaming dependencies are mocked. We assert payload shape,
 * overlay merging, the no-status / no-monitor guards, the prime-completed
 * and pump-stall conditional spreads, and the error guard.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dacMock = vi.hoisted(() => {
  const state: { monitor: { getLastStatus: () => any } | null } = { monitor: null }
  const getDacMonitorIfRunning = vi.fn(() => state.monitor)
  return { state, getDacMonitorIfRunning }
})

const piezoMock = vi.hoisted(() => ({
  broadcastFrame: vi.fn(),
}))

const primeMock = vi.hoisted(() => {
  const state: { primeCompletedAt: number | null } = { primeCompletedAt: null }
  const getPrimeCompletedAt = vi.fn(() => state.primeCompletedAt)
  return { state, getPrimeCompletedAt }
})

const alarmMock = vi.hoisted(() => {
  const state: { left: boolean, right: boolean } = { left: false, right: false }
  const getAlarmState = vi.fn(() => state)
  return { state, getAlarmState }
})

const stallMock = vi.hoisted(() => {
  const state: { left: unknown, right: unknown } = { left: null, right: null }
  const getAllPumpStallNotices = vi.fn(() => ({ left: state.left, right: state.right }))
  return { state, getAllPumpStallNotices }
})

const snoozeMock = vi.hoisted(() => {
  const calls: Array<'left' | 'right'> = []
  const getSnoozeStatus = vi.fn((side: 'left' | 'right') => {
    calls.push(side)
    return { active: false, snoozeUntil: null }
  })
  return { calls, getSnoozeStatus }
})

vi.mock('@/src/hardware/dacMonitor.instance', () => ({
  getDacMonitorIfRunning: dacMock.getDacMonitorIfRunning,
}))

vi.mock('../piezoStream', () => ({
  broadcastFrame: piezoMock.broadcastFrame,
}))

vi.mock('@/src/hardware/primeNotification', () => ({
  getPrimeCompletedAt: primeMock.getPrimeCompletedAt,
}))

vi.mock('@/src/hardware/deviceStateSync', () => ({
  getAlarmState: alarmMock.getAlarmState,
}))

vi.mock('@/src/hardware/pumpStallNotification', () => ({
  getAllPumpStallNotices: stallMock.getAllPumpStallNotices,
}))

vi.mock('@/src/hardware/snoozeManager', () => ({
  getSnoozeStatus: snoozeMock.getSnoozeStatus,
}))

const { broadcastMutationStatus } = await import('../broadcastMutationStatus')

function setLastStatus(status: any | undefined) {
  dacMock.state.monitor = {
    getLastStatus: () => status,
  }
}

const baseStatus = {
  leftSide: { temperatureC: 22, isOn: true },
  rightSide: { temperatureC: 24, isOn: false },
  waterLevel: 0.85,
  isPriming: false,
}

let warnSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dacMock.state.monitor = null
  primeMock.state.primeCompletedAt = null
  alarmMock.state.left = false
  alarmMock.state.right = false
  stallMock.state.left = null
  stallMock.state.right = null
  snoozeMock.calls.length = 0
  dacMock.getDacMonitorIfRunning.mockClear()
  piezoMock.broadcastFrame.mockClear()
  primeMock.getPrimeCompletedAt.mockClear()
  alarmMock.getAlarmState.mockClear()
  stallMock.getAllPumpStallNotices.mockClear()
  snoozeMock.getSnoozeStatus.mockClear()
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warnSpy.mockRestore()
})

describe('broadcastMutationStatus', () => {
  it('returns silently when no monitor is running', () => {
    dacMock.state.monitor = null

    broadcastMutationStatus()

    expect(piezoMock.broadcastFrame).not.toHaveBeenCalled()
  })

  it('returns silently when the monitor has no last status yet', () => {
    setLastStatus(undefined)

    broadcastMutationStatus()

    expect(piezoMock.broadcastFrame).not.toHaveBeenCalled()
  })

  it('broadcasts a deviceStatus frame with the expected envelope and pulled-in fields', () => {
    setLastStatus(baseStatus)

    const before = Date.now()
    broadcastMutationStatus()
    const after = Date.now()

    expect(piezoMock.broadcastFrame).toHaveBeenCalledTimes(1)
    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, unknown>
    expect(frame.type).toBe('deviceStatus')
    expect(typeof frame.ts).toBe('number')
    expect(frame.ts as number).toBeGreaterThanOrEqual(before)
    expect(frame.ts as number).toBeLessThanOrEqual(after)
    expect(frame.waterLevel).toBe(0.85)
    expect(frame.isPriming).toBe(false)
    expect(frame.snooze).toEqual({
      left: { active: false, snoozeUntil: null },
      right: { active: false, snoozeUntil: null },
    })
    expect(snoozeMock.calls).toEqual(['left', 'right'])
    // primeCompletedNotification omitted when null
    expect('primeCompletedNotification' in frame).toBe(false)
  })

  it('merges alarm state into both sides without mutating the source status', () => {
    const status = {
      leftSide: { temperatureC: 22 },
      rightSide: { temperatureC: 24 },
      waterLevel: 0.5,
      isPriming: false,
    }
    setLastStatus(status)
    alarmMock.state.left = true
    alarmMock.state.right = false

    broadcastMutationStatus()

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.leftSide).toEqual({ temperatureC: 22, isAlarmVibrating: true })
    expect(frame.rightSide).toEqual({ temperatureC: 24, isAlarmVibrating: false })
    // Source must not have been mutated.
    expect(status.leftSide).toEqual({ temperatureC: 22 })
    expect(status.rightSide).toEqual({ temperatureC: 24 })
  })

  it('applies a left-side overlay on top of the merged side', () => {
    setLastStatus(baseStatus)

    broadcastMutationStatus('left', { temperatureC: 19, isOn: false })

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.leftSide).toMatchObject({
      temperatureC: 19,
      isOn: false,
      isAlarmVibrating: false,
    })
    // Right side untouched by overlay.
    expect(frame.rightSide).toMatchObject({ temperatureC: 24, isOn: false })
  })

  it('applies a right-side overlay on top of the merged side', () => {
    setLastStatus(baseStatus)

    broadcastMutationStatus('right', { temperatureC: 30 })

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.rightSide).toMatchObject({ temperatureC: 30, isAlarmVibrating: false })
    expect(frame.leftSide).toMatchObject({ temperatureC: 22 })
  })

  it('ignores the overlay when only side is provided (no payload)', () => {
    setLastStatus(baseStatus)

    broadcastMutationStatus('left')

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.leftSide).toEqual({ temperatureC: 22, isOn: true, isAlarmVibrating: false })
  })

  it('ignores an overlay payload when no side is provided', () => {
    setLastStatus(baseStatus)

    broadcastMutationStatus(undefined, { temperatureC: 99, isOn: false })

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.leftSide).toEqual({ temperatureC: 22, isOn: true, isAlarmVibrating: false })
    expect(frame.rightSide).toEqual({ temperatureC: 24, isOn: false, isAlarmVibrating: false })
  })

  it('includes primeCompletedNotification when a timestamp is set', () => {
    setLastStatus(baseStatus)
    primeMock.state.primeCompletedAt = 1_700_000_000_000

    broadcastMutationStatus()

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.primeCompletedNotification).toEqual({ timestamp: 1_700_000_000_000 })
  })

  it('includes pumpStallNotifications when one side has an active notice', () => {
    setLastStatus(baseStatus)
    stallMock.state.right = { alertId: 42, trippedAt: 1_700_000_000, rpm: 0, restore: null }

    broadcastMutationStatus()

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, any>
    expect(frame.pumpStallNotifications).toEqual({
      left: null,
      right: { alertId: 42, trippedAt: 1_700_000_000, rpm: 0, restore: null },
    })
  })

  it('omits pumpStallNotifications when both sides are null', () => {
    setLastStatus(baseStatus)

    broadcastMutationStatus()

    const frame = piezoMock.broadcastFrame.mock.calls[0]?.[0] as Record<string, unknown>
    expect('pumpStallNotifications' in frame).toBe(false)
  })

  it('catches and logs errors thrown by downstream dependencies', () => {
    setLastStatus(baseStatus)
    piezoMock.broadcastFrame.mockImplementationOnce(() => {
      throw new Error('socket closed')
    })

    expect(() => broadcastMutationStatus()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      '[broadcastMutationStatus]',
      expect.any(Error),
    )
  })

  it('catches errors thrown by getLastStatus itself', () => {
    dacMock.state.monitor = {
      getLastStatus: () => {
        throw new Error('monitor offline')
      },
    }

    expect(() => broadcastMutationStatus()).not.toThrow()
    expect(piezoMock.broadcastFrame).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      '[broadcastMutationStatus]',
      expect.any(Error),
    )
  })
})
