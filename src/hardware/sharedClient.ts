/**
 * Production HardwareClient used by every writer in the app — tRPC routers,
 * scheduler jobs, gesture actions, HomeKit accessories, services. All callers
 * share one instance backed by the singleton DacTransport connection so the
 * pod sees a single FIFO of commands instead of competing writers.
 *
 * This is the **only** path that should issue commands to the hardware in
 * production. The `HardwareClient` class in `./client.ts` is the dev/test
 * variant that opens its own socket — do not use it from app code.
 *
 * Lifecycle: started by `startDacServer()` in `./dacMonitor.instance.ts`,
 * cleared by `clearSharedHardwareClient()` during shutdown.
 */

import { connectDac, isDacConnected, sendCommand } from './dacTransport'
import { encodeAlarmPayload } from './alarmPayload'
import { parseDeviceStatus, parseSimpleResponse } from './responseParser'
import type { HardwareClient } from './client'
import {
  type AlarmConfig,
  type DeviceStatus,
  type Side,
  DEFAULT_HEATING_DURATION,
  HardwareCommand,
  HardwareError,
  fahrenheitToLevel,
  MAX_TEMP,
  MIN_TEMP,
} from './types'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'
const CLIENT_KEY = '__sp_hw_client__'

/**
 * Last-resort target when a caller asks to power a side ON without supplying
 * a temperature. Real callers (HomeKit, gestures, scheduler) all pass an
 * explicit target sourced from cache/state; this fallback only fires for
 * legacy paths (e.g. mqttBridge passthrough with no temperature in payload)
 * so the pod doesn't sit at level 0 after a power-on.
 */
const POWER_ON_FALLBACK_F = 75
const g = globalThis as Record<string, unknown>

/**
 * Thin wrapper around sendCommand() that presents the same interface as the
 * dev `HardwareClient`. Duck-typed, not nominally — callers depend on the
 * shape, not the class identity.
 */
class DacHardwareClient {
  async connect(): Promise<void> {
    if (!isDacConnected()) {
      await connectDac(DAC_SOCK_PATH)
    }
  }

  async getDeviceStatus(): Promise<DeviceStatus> {
    const response = await sendCommand(HardwareCommand.DEVICE_STATUS)
    return parseDeviceStatus(response)
  }

  async setTemperature(side: Side, temperature: number, duration?: number): Promise<void> {
    if (temperature < MIN_TEMP || temperature > MAX_TEMP) {
      throw new HardwareError(`Temperature must be between ${MIN_TEMP}°F and ${MAX_TEMP}°F`)
    }

    const level = fahrenheitToLevel(temperature)

    const levelCommand = side === 'left'
      ? HardwareCommand.TEMP_LEVEL_LEFT
      : HardwareCommand.TEMP_LEVEL_RIGHT

    await sendCommand(levelCommand, level.toString())

    const durationCommand = side === 'left'
      ? HardwareCommand.LEFT_TEMP_DURATION
      : HardwareCommand.RIGHT_TEMP_DURATION

    await sendCommand(durationCommand, (duration ?? DEFAULT_HEATING_DURATION).toString())
  }

  async setAlarm(side: Side, config: AlarmConfig): Promise<void> {
    if (config.vibrationIntensity < 1 || config.vibrationIntensity > 100) {
      throw new HardwareError('Vibration intensity must be between 1 and 100')
    }
    if (config.duration < 0 || config.duration > 180) {
      throw new HardwareError('Alarm duration must be between 0 and 180 seconds')
    }

    // Route per-side: ALARM_LEFT (cmd 5) or ALARM_RIGHT (cmd 6) with hex-CBOR.
    // Verified live on Pod 5 (J55) cover on 2026-05-11 against journalctl -u frank:
    // cmd 5/6 + CBOR → `sparkAlarmL/R` fires → `triggerVibrationAlarm side X` →
    // `[alarm io] side N power P pattern X for D` writes to the cover MCU and
    // the motor engages. The `Pillow.cpp:383 ... label uninitialized` log that
    // appears alongside is the SEPARATE pillow-accessory code path and does NOT
    // gate the cover motor. ALARM_SOLO (cmd 2) appears in the wire protocol but
    // frank has no registered spark function at that opcode on this firmware —
    // commands are silently dropped (no `sparkAlarmS` log, no motor write).
    const cmd = side === 'left' ? HardwareCommand.ALARM_LEFT : HardwareCommand.ALARM_RIGHT
    const response = await sendCommand(cmd, encodeAlarmPayload(config))
    const parsed = parseSimpleResponse(response)

    if (!parsed.success) {
      throw new HardwareError(`Failed to set alarm: ${parsed.message}`)
    }
  }

  async clearAlarm(side: Side): Promise<void> {
    await sendCommand(HardwareCommand.ALARM_CLEAR, side === 'left' ? '0' : '1')
  }

  async startPriming(): Promise<void> {
    const response = await sendCommand(HardwareCommand.PRIME)
    const parsed = parseSimpleResponse(response)

    if (!parsed.success) {
      throw new HardwareError(`Failed to start priming: ${parsed.message}`)
    }
  }

  async setPower(side: Side, powered: boolean, temperature?: number): Promise<void> {
    if (powered) {
      const temp = temperature ?? POWER_ON_FALLBACK_F
      await this.setTemperature(side, temp)
    }
    else {
      const command = side === 'left'
        ? HardwareCommand.TEMP_LEVEL_LEFT
        : HardwareCommand.TEMP_LEVEL_RIGHT

      const response = await sendCommand(command, '0')
      const parsed = parseSimpleResponse(response)

      if (!parsed.success) {
        throw new HardwareError(`Failed to power off: ${parsed.message}`)
      }
    }
  }

  isConnected(): boolean {
    return isDacConnected()
  }

  // DEBUG passthrough for device.execute. Lives on the client (not as a
  // free function) so the call binds to the same `dacTransport` module
  // instance that owns the live `transport` singleton — importing
  // sendCommand directly into a route handler can resolve to a separate
  // Next.js bundle whose `transport` is undefined.
  async sendRaw(command: string, args?: string): Promise<string> {
    if (!isDacConnected()) {
      await connectDac(DAC_SOCK_PATH)
    }
    return sendCommand(command, args)
  }

  disconnect(): void {
    // No-op for the shared client — disconnectDac() runs at app shutdown.
    // Per-caller teardown would kill the shared connection for every other consumer.
  }

  getRawClient(): null {
    return null
  }
}

export function getSharedHardwareClient(): HardwareClient {
  if (g[CLIENT_KEY]) return g[CLIENT_KEY] as HardwareClient
  const client = new DacHardwareClient() as unknown as HardwareClient
  g[CLIENT_KEY] = client
  return client
}

/** Used by the DAC monitor's shutdown path. Not for general use. */
export function clearSharedHardwareClient(): void {
  g[CLIENT_KEY] = null
}
