import type { HardwareClient } from './client'
import { MAX_TEMP, MIN_TEMP, type Side } from './types'
import type { GestureEvent } from './dacMonitor'

// Re-export for callers that need to build deps
export type { GestureActionDeps }

// These types mirror the DB row shapes without importing from @/src/db
export interface TapGestureRow {
  actionType: 'temperature' | 'alarm'
  temperatureChange: 'increment' | 'decrement' | null
  temperatureAmount: number | null
  alarmBehavior: 'snooze' | 'dismiss' | null
  /** Duration in seconds before a snoozed alarm restarts. */
  alarmSnoozeDuration: number | null
  /** Action when the alarm is not currently vibrating. `'power'` toggles pod power; `'none'` is a no-op. */
  alarmInactiveBehavior: 'power' | 'none' | null
}

export interface DeviceStateRow {
  targetTemperature: number | null
  isPowered: boolean
  isAlarmVibrating: boolean
}

interface GestureActionDeps {
  findGestureConfig: (side: Side, tapType: GestureEvent['tapType']) => Promise<TapGestureRow | null>
  findDeviceState: (side: Side) => Promise<DeviceStateRow | null>
  newHardwareClient: (socketPath: string) => HardwareClient
}

/**
 * Consumes gesture:detected events and executes the configured hardware action.
 * Uses per-operation HardwareClient (same pattern as tRPC routers).
 * Errors in action execution are caught and logged — never propagate.
 *
 * Note on isAlarmVibrating: the hardware DEVICE_STATUS response does not
 * include alarm vibration state. The value is sourced from device_state DB
 * which is set externally (e.g., by the alarm scheduler) before/after alarms.
 * If device_state is stale the alarm action will fall through to the
 * alarmInactiveBehavior path.
 *
 * Pass `deps` to override DB/hardware behaviour in tests (dependency injection).
 */
export class GestureActionHandler {
  private readonly deps: GestureActionDeps
  private readonly snoozeTimeouts: Set<ReturnType<typeof setTimeout>> = new Set()

  constructor(
    private readonly socketPath: string,
    deps: GestureActionDeps
  ) {
    this.deps = deps
  }

  handle = async (event: GestureEvent): Promise<void> => {
    try {
      await this.execute(event)
    }
    catch (error) {
      console.error(
        `GestureActionHandler: error executing action for ${event.side} ${event.tapType}:`,
        error instanceof Error ? error.message : error
      )
    }
  }

  /**
   * Cancel all pending snooze restart timers.
   * Call this during application shutdown to allow clean process exit.
   */
  cleanup = (): void => {
    for (const id of this.snoozeTimeouts) {
      clearTimeout(id)
    }
    this.snoozeTimeouts.clear()
  }

  private execute = async (event: GestureEvent): Promise<void> => {
    const gesture = await this.deps.findGestureConfig(event.side, event.tapType)
    if (!gesture) return

    if (gesture.actionType === 'temperature') {
      await this.handleTemperatureAction(event, gesture)
    }
    else if (gesture.actionType === 'alarm') {
      await this.handleAlarmAction(event, gesture)
    }
  }

  private handleTemperatureAction = async (
    event: GestureEvent,
    gesture: TapGestureRow
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(event.side)
    const currentTemp = state?.targetTemperature ?? 75
    const amount = gesture.temperatureAmount ?? 0
    const delta = gesture.temperatureChange === 'increment' ? amount : -amount
    const newTemp = Math.min(MAX_TEMP, Math.max(MIN_TEMP, currentTemp + delta))

    const client = this.deps.newHardwareClient(this.socketPath)
    try {
      await client.connect()
      await client.setTemperature(event.side, newTemp)
    }
    finally {
      client.disconnect()
    }
  }

  private handleAlarmAction = async (
    event: GestureEvent,
    gesture: TapGestureRow
  ): Promise<void> => {
    const state = await this.deps.findDeviceState(event.side)
    const isAlarmVibrating = state?.isAlarmVibrating ?? false

    if (isAlarmVibrating) {
      const client = this.deps.newHardwareClient(this.socketPath)
      try {
        await client.connect()

        if (gesture.alarmBehavior === 'dismiss') {
          await client.clearAlarm(event.side)
        }
        else if (gesture.alarmBehavior === 'snooze') {
          await client.clearAlarm(event.side)
          const snoozeDuration = gesture.alarmSnoozeDuration ?? 300
          const timeoutId = setTimeout(() => {
            this.snoozeTimeouts.delete(timeoutId)
            const restartClient = this.deps.newHardwareClient(this.socketPath)
            restartClient.connect()
              .then(() => restartClient.setAlarm(event.side, {
                vibrationIntensity: 50,
                vibrationPattern: 'rise',
                duration: 180,
              }))
              .catch(err => console.error('GestureActionHandler: snooze restart failed:', err))
              .finally(() => restartClient.disconnect())
          }, snoozeDuration * 1000)
          this.snoozeTimeouts.add(timeoutId)
        }
      }
      finally {
        client.disconnect()
      }
    }
    else {
      if (gesture.alarmInactiveBehavior === 'power') {
        const currentlyPowered = state?.isPowered ?? false
        const client = this.deps.newHardwareClient(this.socketPath)
        try {
          await client.connect()
          await client.setPower(event.side, !currentlyPowered)
        }
        finally {
          client.disconnect()
        }
      }
      // alarmInactiveBehavior === 'none': no-op
    }
  }
}
