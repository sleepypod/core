import type { HardwareClient } from './client'
import { MAX_TEMP, MIN_TEMP, type Side } from './types'
import type { GestureEvent } from './dacMonitor'
import type { AlarmConfig } from './alarmPersistence'
import { getTemperatureController } from '@/src/temperature/instance'
import { shouldBlock as pumpStallShouldBlock } from './pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'

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

/** Alarm bookkeeping (alarmState / snoozeManager in production). */
export interface AlarmHooks {
  /** Settings of the alarm vibrating on `side`, to repeat after a snooze. */
  activeConfig: (side: Side) => AlarmConfig | null
  /** The alarm on `side` stopped (dismissed, snoozed, or by the firmware). */
  ended: (side: Side) => Promise<void>
  snooze: (side: Side, seconds: number, config: AlarmConfig) => void
  cancelSnooze: (side: Side) => void
}

interface GestureActionDeps {
  findGestureConfig: (side: Side, tapType: GestureEvent['tapType']) => Promise<TapGestureRow | null>
  findDeviceState: (side: Side) => Promise<DeviceStateRow | null>
  newHardwareClient: (socketPath: string) => HardwareClient
  alarm: AlarmHooks
}

/** Repeated after a snooze when the snoozed alarm's own settings are unknown. */
export const DEFAULT_SNOOZE_ALARM: AlarmConfig = {
  vibrationIntensity: 50,
  vibrationPattern: 'rise',
  duration: 180,
}

/**
 * Consumes gesture:detected events and executes the configured hardware action.
 * Uses per-operation HardwareClient (same pattern as tRPC routers).
 * Errors in action execution are caught and logged — never propagate.
 *
 * Note on isAlarmVibrating: the hardware DEVICE_STATUS response does not
 * include alarm vibration state. The value is sourced from device_state DB,
 * kept by alarmState: every path that starts an alarm marks it vibrating
 * and it is cleared when the alarm stops or its duration runs out.
 *
 * The firmware itself stops a vibrating alarm on any tap gesture, so a
 * gesture that isn't an alarm action still marks the alarm ended.
 *
 * Pass `deps` to override DB/hardware behaviour in tests (dependency injection).
 */
export class GestureActionHandler {
  private readonly deps: GestureActionDeps

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

  private execute = async (event: GestureEvent): Promise<void> => {
    const gesture = await this.deps.findGestureConfig(event.side, event.tapType)
    if (gesture?.actionType !== 'alarm') {
      // The firmware already stopped any vibrating alarm on this tap.
      const state = await this.deps.findDeviceState(event.side)
      if (state?.isAlarmVibrating) await this.deps.alarm.ended(event.side)
    }
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
    await withSideLock(event.side, async () => {
      // Step from the temperature SleepyPod itself has set (the controller's
      // selected target), not the firmware's reported target: the firmware
      // applies its own tap adjustment (one Eight Sleep step, 2.75°F) before
      // this runs, and the status may already include it. Writing the result
      // as an absolute target then replaces that adjustment, so a tap moves
      // exactly the configured amount instead of both added together.
      const owned = getTemperatureController().status(event.side).targetTemperature
      const currentTemp = owned
        ?? (await this.deps.findDeviceState(event.side))?.targetTemperature
        ?? 75
      const amount = gesture.temperatureAmount ?? 0
      if (!gesture.temperatureChange) return
      const delta = gesture.temperatureChange === 'increment' ? amount : -amount
      const newTemp = Math.min(MAX_TEMP, Math.max(MIN_TEMP, currentTemp + delta))
      if (pumpStallShouldBlock(event.side)) {
        console.warn(`[gestureActionHandler] skipped setTemperature: pump stall guard blocks ${event.side}`)
        return
      }
      await getTemperatureController().setManualLocked(event.side, newTemp)
    })
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
          this.deps.alarm.cancelSnooze(event.side)
          await this.deps.alarm.ended(event.side)
        }
        else if (gesture.alarmBehavior === 'snooze') {
          // Read before ended() forgets it: the snoozed alarm comes back as it was.
          const config = this.deps.alarm.activeConfig(event.side) ?? DEFAULT_SNOOZE_ALARM
          await client.clearAlarm(event.side)
          await this.deps.alarm.ended(event.side)
          this.deps.alarm.snooze(event.side, gesture.alarmSnoozeDuration ?? 300, config)
        }
        else {
          // No alarm behavior configured: the firmware still stopped it.
          await this.deps.alarm.ended(event.side)
        }
      }
      finally {
        client.disconnect()
      }
    }
    else {
      if (gesture.alarmInactiveBehavior === 'power') {
        await withSideLock(event.side, async () => {
          // Resolve the toggle after older queued commands have updated state.
          const current = await this.deps.findDeviceState(event.side)
          const nextPowered = !(current?.isPowered ?? false)
          const target = current?.targetTemperature ?? 75
          if (nextPowered && pumpStallShouldBlock(event.side)) {
            console.warn(`[gestureActionHandler] skipped power-on: pump stall guard blocks ${event.side}`)
            return
          }
          const client = this.deps.newHardwareClient(this.socketPath)
          try {
            await client.connect()
            if (nextPowered) await getTemperatureController().setManualLocked(event.side, target)
            else await getTemperatureController().powerOffLocked(event.side)
          }
          finally {
            client.disconnect()
          }
        })
      }
      // alarmInactiveBehavior === 'none': no-op
    }
  }
}
