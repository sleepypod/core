import { afterEach, describe, expect, test, vi } from 'vitest'
import type { GestureActionDeps } from '../gestureActionHandler'
import type { GestureEvent } from '../dacMonitor'
import type { HardwareClient } from '../client'
import { TEMP_NEUTRAL } from '../types'

const registerManualOverride = vi.fn()
const pumpStallShouldBlock = vi.fn<(side: 'left' | 'right') => boolean>(() => false)

vi.mock('@/src/automation', () => ({
  getAutomationEngineIfRunning: () => ({ registerManualOverride }),
}))
vi.mock('../pumpStallGuard', () => ({
  shouldBlock: (side: 'left' | 'right') => pumpStallShouldBlock(side),
}))

const { GestureActionHandler } = await import('../gestureActionHandler')
const { withSideLock } = await import('../sideLock')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SOCKET_PATH = '/tmp/test-gesture.sock'

const makeEvent = (
  side: 'left' | 'right',
  tapType: 'doubleTap' | 'tripleTap' | 'quadTap'
): GestureEvent => ({ side, tapType, timestamp: new Date() })

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

const makeMockClient = (overrides: DeepPartial<HardwareClient> = {}): HardwareClient => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  setTemperature: vi.fn().mockResolvedValue(undefined),
  clearAlarm: vi.fn().mockResolvedValue(undefined),
  setPower: vi.fn().mockResolvedValue(undefined),
  setAlarm: vi.fn().mockResolvedValue(undefined),
  ...overrides,
} as unknown as HardwareClient)

const makeDeps = (
  gestureRow: object | null = null,
  stateRow: object | null = null,
  client: HardwareClient = makeMockClient()
): { deps: GestureActionDeps, client: HardwareClient } => ({
  client,
  deps: {
    findGestureConfig: vi.fn().mockResolvedValue(gestureRow),
    findDeviceState: vi.fn().mockResolvedValue(stateRow),
    newHardwareClient: vi.fn().mockReturnValue(client),
  },
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GestureActionHandler', () => {
  afterEach(() => {
    vi.clearAllTimers()
    registerManualOverride.mockClear()
    pumpStallShouldBlock.mockReset().mockReturnValue(false)
    vi.useRealTimers()
  })

  test('no-op when no gesture config row exists', async () => {
    const { deps, client } = makeDeps(null)
    const handler = new GestureActionHandler(SOCKET_PATH, deps)

    await handler.handle(makeEvent('left', 'doubleTap'))

    expect((client.setTemperature as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((client.clearAlarm as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect((client.setPower as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  test('ignores an unrecognised actionType defensively', async () => {
    const { deps, client } = makeDeps({ actionType: 'future-action' })

    await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

    expect(deps.findDeviceState).not.toHaveBeenCalled()
    expect(deps.newHardwareClient).not.toHaveBeenCalled()
    expect(client.connect).not.toHaveBeenCalled()
  })

  describe('temperature action', () => {
    test('waits behind the shared side lock before writing hardware', async () => {
      let releaseLeft: () => void = () => {}
      const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
        releaseLeft = resolve
      }))
      await Promise.resolve()

      try {
        const client = makeMockClient()
        const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
        const deps: GestureActionDeps = {
          findGestureConfig: vi.fn().mockResolvedValue(gesture),
          findDeviceState: vi.fn().mockResolvedValue({ targetTemperature: 70 }),
          newHardwareClient: vi.fn().mockReturnValue(client),
        }
        const handler = new GestureActionHandler(SOCKET_PATH, deps)

        const left = handler.handle(makeEvent('left', 'doubleTap'))
        await Promise.resolve()
        expect(client.setTemperature).not.toHaveBeenCalled()

        await handler.handle(makeEvent('right', 'doubleTap'))
        expect(client.setTemperature).toHaveBeenCalledWith('right', 75)
        expect(client.setTemperature).not.toHaveBeenCalledWith('left', 75)

        releaseLeft()
        await holder
        await left

        expect(client.setTemperature).toHaveBeenCalledWith('left', 75)
      }
      finally {
        releaseLeft()
        await holder.catch(() => {})
      }
    })

    test('increments temperature', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
      const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 75)
      expect(registerManualOverride).toHaveBeenCalledWith('left')
      expect(client.disconnect).toHaveBeenCalledOnce()
    })

    test('decrements temperature', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 3 }
      const state = { targetTemperature: 80 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'tripleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('right', 77)
    })

    test('clamps to MIN_TEMP (55°F)', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 10 }
      const state = { targetTemperature: 57 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 55)
    })

    test('clamps to MAX_TEMP (110°F)', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 10 }
      const state = { targetTemperature: 108 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('right', 110)
    })

    test('defaults to 75°F when no device state row', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 2 }
      const { deps, client } = makeDeps(gesture, null)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 77)
    })

    test('skips a misconfigured row with no temperature direction', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: null, temperatureAmount: 5 }
      const { deps, client } = makeDeps(gesture, { targetTemperature: 70 })

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(deps.newHardwareClient).not.toHaveBeenCalled()
      expect(client.setTemperature).not.toHaveBeenCalled()
    })
  })

  describe('alarm action — active alarm', () => {
    test('dismisses active alarm', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss' }
      const state = { isAlarmVibrating: true, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.clearAlarm).toHaveBeenCalledWith('left')
      expect(client.disconnect).toHaveBeenCalledOnce()
    })

    test('snoozes active alarm — clears immediately', async () => {
      vi.useFakeTimers()
      const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 300 }
      const state = { isAlarmVibrating: true, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))

      expect(client.clearAlarm).toHaveBeenCalledWith('left')
    })

    test('snooze restarts alarm after duration', async () => {
      vi.useFakeTimers()
      const snoozeClient = makeMockClient()
      const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 300 }
      const state = { isAlarmVibrating: true }
      const newHardwareClient = vi.fn()
        .mockReturnValueOnce(makeMockClient()) // first call: clear alarm
        .mockReturnValueOnce(snoozeClient) // second call: restart alarm
      const deps: GestureActionDeps = {
        findGestureConfig: vi.fn().mockResolvedValue(gesture),
        findDeviceState: vi.fn().mockResolvedValue(state),
        newHardwareClient,
      }

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))

      await vi.advanceTimersByTimeAsync(299_999)
      expect(snoozeClient.connect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()

      expect(snoozeClient.setAlarm).toHaveBeenCalledWith('left', expect.objectContaining({
        vibrationIntensity: 50,
        vibrationPattern: 'rise',
        duration: 180,
      }))
      expect(snoozeClient.disconnect).toHaveBeenCalledOnce()
    })

    test('does nothing for an active alarm with no configured behavior', async () => {
      vi.useFakeTimers()
      const gesture = { actionType: 'alarm', alarmBehavior: null }
      const { deps, client } = makeDeps(gesture, { isAlarmVibrating: true })

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(client.connect).toHaveBeenCalledOnce()
      expect(client.clearAlarm).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
      expect(client.disconnect).toHaveBeenCalledOnce()
    })

    test('clamps a huge snooze to the signed 32-bit timer ceiling', async () => {
      vi.useFakeTimers()
      const maxSeconds = Math.floor((2 ** 31 - 1) / 1000)
      const restart = makeMockClient()
      const deps: GestureActionDeps = {
        findGestureConfig: vi.fn().mockResolvedValue({
          actionType: 'alarm',
          alarmBehavior: 'snooze',
          alarmSnoozeDuration: Number.MAX_SAFE_INTEGER,
        }),
        findDeviceState: vi.fn().mockResolvedValue({ isAlarmVibrating: true }),
        newHardwareClient: vi.fn()
          .mockReturnValueOnce(makeMockClient())
          .mockReturnValueOnce(restart),
      }

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))
      await vi.advanceTimersByTimeAsync(maxSeconds * 1000 - 1)
      expect(restart.connect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(restart.setAlarm).toHaveBeenCalledOnce()
    })
  })

  describe('alarm action — inactive alarm', () => {
    test('power toggle waits behind the shared side lock before writing hardware', async () => {
      let releaseLeft: () => void = () => {}
      const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
        releaseLeft = resolve
      }))
      await Promise.resolve()

      try {
        const client = makeMockClient()
        const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
        const { deps } = makeDeps(gesture, { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }, client)
        const pending = new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))
        await Promise.resolve()

        expect(client.setPower).not.toHaveBeenCalled()

        releaseLeft()
        await holder
        await pending

        expect(client.setPower).toHaveBeenCalledWith('left', true, 70)
      }
      finally {
        releaseLeft()
        await holder.catch(() => {})
      }
    })

    test('toggles power on when pod is off (alarmInactiveBehavior=power) — preserves polled target', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).toHaveBeenCalledWith('left', true, 70)
      expect(registerManualOverride).toHaveBeenCalledWith('left')
    })

    test('power-on falls back to TEMP_NEUTRAL when no targetTemperature is cached', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: null }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).toHaveBeenCalledWith('left', true, 82.5)
    })

    test('treats a missing state row as inactive and powered off', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const { deps, client } = makeDeps(gesture, null)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(client.clearAlarm).not.toHaveBeenCalled()
      expect(client.setPower).toHaveBeenCalledWith('right', true, TEMP_NEUTRAL)
      expect(client.disconnect).toHaveBeenCalledOnce()
    })

    test('toggles power off when pod is on (alarmInactiveBehavior=power)', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: true, targetTemperature: 72 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(client.setPower).toHaveBeenCalledWith('right', false, undefined)
    })

    test('no-op when alarmInactiveBehavior=none', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'none' }
      const state = { isAlarmVibrating: false, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).not.toHaveBeenCalled()
      expect(client.clearAlarm).not.toHaveBeenCalled()
    })
  })

  test('cleanup() cancels pending snooze restart timers so process can exit', async () => {
    vi.useFakeTimers()
    const snoozeClient = makeMockClient()
    const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 300 }
    const state = { isAlarmVibrating: true }
    const newHardwareClient = vi.fn()
      .mockReturnValueOnce(makeMockClient())
      .mockReturnValueOnce(snoozeClient)
    const deps: GestureActionDeps = {
      findGestureConfig: vi.fn().mockResolvedValue(gesture),
      findDeviceState: vi.fn().mockResolvedValue(state),
      newHardwareClient,
    }

    const handler = new GestureActionHandler(SOCKET_PATH, deps)
    await handler.handle(makeEvent('left', 'tripleTap'))

    handler.cleanup()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(snoozeClient.setAlarm).not.toHaveBeenCalled()
  })

  test('snooze restart logs without throwing when restart connect fails', async () => {
    vi.useFakeTimers()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failingClient = makeMockClient({
      connect: vi.fn().mockRejectedValue(new Error('connect refused')),
    })
    const gesture = { actionType: 'alarm', alarmBehavior: 'snooze', alarmSnoozeDuration: 1 }
    const state = { isAlarmVibrating: true }
    const newHardwareClient = vi.fn()
      .mockReturnValueOnce(makeMockClient())
      .mockReturnValueOnce(failingClient)
    const deps: GestureActionDeps = {
      findGestureConfig: vi.fn().mockResolvedValue(gesture),
      findDeviceState: vi.fn().mockResolvedValue(state),
      newHardwareClient,
    }

    await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'tripleTap'))
    await vi.advanceTimersByTimeAsync(1000)
    // Allow promise chain to resolve
    await vi.advanceTimersByTimeAsync(100)
    expect(errSpy).toHaveBeenCalledWith('GestureActionHandler: snooze restart failed:', expect.any(Error))
    errSpy.mockRestore()
  })

  test('errors in execution do not throw', async () => {
    const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
    const client = makeMockClient({
      setTemperature: vi.fn().mockRejectedValue(new Error('hardware failure')),
    })
    const { deps } = makeDeps(gesture, { targetTemperature: 70 }, client)

    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))
    ).resolves.not.toThrow()
    expect(error).toHaveBeenCalledWith(
      'GestureActionHandler: error executing action for left doubleTap:',
      'hardware failure',
    )
    expect(client.disconnect).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  describe('pump stall guard', () => {
    test('skips a temperature gesture while the guard blocks the side', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      pumpStallShouldBlock.mockReturnValue(true)
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
      const { deps, client } = makeDeps(gesture, { targetTemperature: 70 })

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(deps.newHardwareClient).not.toHaveBeenCalled()
      expect(client.setTemperature).not.toHaveBeenCalled()
      expect(registerManualOverride).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('[gestureActionHandler] skipped setTemperature: pump stall guard blocks left')
      warn.mockRestore()
    })

    test('skips a power-on toggle while the guard blocks the side', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      pumpStallShouldBlock.mockReturnValue(true)
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(deps.newHardwareClient).not.toHaveBeenCalled()
      expect(client.setPower).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalledWith('[gestureActionHandler] skipped power-on: pump stall guard blocks right')
      warn.mockRestore()
    })

    test('still allows a power-off toggle while the guard blocks the side', async () => {
      pumpStallShouldBlock.mockReturnValue(true)
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: true, targetTemperature: 72 }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(client.setPower).toHaveBeenCalledWith('right', false, undefined)
    })

    test('blocks a temperature gesture whose trip lands while queued on the side lock', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release: () => void = () => {}
      const holder = withSideLock('left', async () => new Promise<void>((resolve) => {
        release = resolve
      }))
      await Promise.resolve()

      try {
        const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
        const { deps, client } = makeDeps(gesture, { targetTemperature: 70 })
        const pending = new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))
        // The gesture queues behind the held lock while the guard is still
        // healthy — the trip below lands strictly after.
        await new Promise((resolve) => {
          setTimeout(resolve, 0)
        })
        pumpStallShouldBlock.mockReturnValue(true)
        release()
        await holder
        await pending

        expect(client.setTemperature).not.toHaveBeenCalled()
        expect(registerManualOverride).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith('[gestureActionHandler] skipped setTemperature: pump stall guard blocks left')
      }
      finally {
        release()
        warn.mockRestore()
      }
    })

    test('blocks a power-on toggle whose trip lands while queued on the side lock', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let release: () => void = () => {}
      const holder = withSideLock('right', async () => new Promise<void>((resolve) => {
        release = resolve
      }))
      await Promise.resolve()

      try {
        const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
        const state = { isAlarmVibrating: false, isPowered: false, targetTemperature: 70 }
        const { deps, client } = makeDeps(gesture, state)
        const pending = new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))
        await new Promise((resolve) => {
          setTimeout(resolve, 0)
        })
        pumpStallShouldBlock.mockReturnValue(true)
        release()
        await holder
        await pending

        expect(client.setPower).not.toHaveBeenCalled()
        expect(registerManualOverride).not.toHaveBeenCalled()
        expect(warn).toHaveBeenCalledWith('[gestureActionHandler] skipped power-on: pump stall guard blocks right')
      }
      finally {
        release()
        warn.mockRestore()
      }
    })
  })
})
