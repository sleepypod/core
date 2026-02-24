import { afterEach, describe, expect, test, vi } from 'vitest'
import { GestureActionHandler, type GestureActionDeps } from '../gestureActionHandler'
import type { GestureEvent } from '../dacMonitor'
import type { HardwareClient } from '../client'

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

  describe('temperature action', () => {
    test('increments temperature', async () => {
      const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
      const state = { targetTemperature: 70, isPowered: true, isAlarmVibrating: false }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setTemperature).toHaveBeenCalledWith('left', 75)
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
  })

  describe('alarm action — active alarm', () => {
    test('dismisses active alarm', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss' }
      const state = { isAlarmVibrating: true, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.clearAlarm).toHaveBeenCalledWith('left')
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

      await vi.advanceTimersByTimeAsync(300_000)

      expect(snoozeClient.setAlarm).toHaveBeenCalledWith('left', expect.objectContaining({
        vibrationIntensity: 50,
        vibrationPattern: 'rise',
      }))
    })
  })

  describe('alarm action — inactive alarm', () => {
    test('toggles power on when pod is off (alarmInactiveBehavior=power)', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: false }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))

      expect(client.setPower).toHaveBeenCalledWith('left', true)
    })

    test('toggles power off when pod is on (alarmInactiveBehavior=power)', async () => {
      const gesture = { actionType: 'alarm', alarmBehavior: 'dismiss', alarmInactiveBehavior: 'power' }
      const state = { isAlarmVibrating: false, isPowered: true }
      const { deps, client } = makeDeps(gesture, state)

      await new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('right', 'quadTap'))

      expect(client.setPower).toHaveBeenCalledWith('right', false)
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

  test('errors in execution do not throw', async () => {
    const gesture = { actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 5 }
    const client = makeMockClient({
      setTemperature: vi.fn().mockRejectedValue(new Error('hardware failure')),
    })
    const { deps } = makeDeps(gesture, { targetTemperature: 70 }, client)

    await expect(
      new GestureActionHandler(SOCKET_PATH, deps).handle(makeEvent('left', 'doubleTap'))
    ).resolves.not.toThrow()
  })
})
