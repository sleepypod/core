/**
 * Global hardware singleton — ONE franken connection, ONE client, ONE monitor.
 *
 * Lifecycle (managed by instrumentation.ts):
 *   1. startDacServer()     — connectDac() on dac.sock
 *   2. getDacMonitor()      — create monitor + client, start polling when connected
 *   3. shutdownDacMonitor() — disconnectDac() + stop everything
 *
 * All consumers (DacMonitor, device router, health router) share the same
 * DacTransport connection and HardwareClient. No competing listeners.
 *
 * The HardwareClient returned by getSharedHardwareClient() is a thin wrapper
 * around sendCommand() from ./dacTransport — it implements the same interface
 * as the old SocketClient-based HardwareClient.
 */

import { connectDac, disconnectDac, sendCommand, isDacConnected } from './dacTransport'
import { DacMonitor } from './dacMonitor'
import type { HardwareClient } from './client'
import { GestureActionHandler } from './gestureActionHandler'
import { defaultGestureActionDeps } from './gestureActionHandler.deps'
import { DeviceStateSync } from './deviceStateSync'
import { parseDeviceStatus, parseSimpleResponse } from './responseParser'
import {
  type AlarmConfig,
  type DeviceStatus,
  type Side,
  HardwareCommand,
  HardwareError,
  fahrenheitToLevel,
  MAX_TEMP,
  MIN_TEMP,
} from './types'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'

// ── Singleton storage on globalThis (survives Turbopack module duplication) ──

const KEYS = {
  server: '__sp_dac_server__',
  client: '__sp_hw_client__',
  monitor: '__sp_dac_monitor__',
  gesture: '__sp_gesture_handler__',
} as const

const g = globalThis as Record<string, unknown>

// ── DacTransport connection (replaces DacSocketServer) ──

export async function startDacServer(): Promise<void> {
  if (g[KEYS.server]) return

  // connectDac blocks until frankenfirmware connects. Run it non-blocking
  // so the app can start in degraded mode if hardware isn't available yet.
  connectDac(DAC_SOCK_PATH).catch((error) => {
    console.warn('[DAC] connection failed (will retry on next command):', error instanceof Error ? error.message : error)
  })
  g[KEYS.server] = true
}

export function getDacServer(): unknown {
  return g[KEYS.server] ?? null
}

// ── DacHardwareClient — same interface as HardwareClient, backed by sendCommand() ──

/**
 * Thin wrapper around sendCommand() that presents the same interface as
 * the original HardwareClient. All consumers (DacMonitor, tRPC routers,
 * gesture handler, job manager) use this without knowing the backend changed.
 */
class DacHardwareClient {
  async connect(): Promise<void> {
    // connectDac is called in startDacServer().
    // If not yet connected, connect now.
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

    if (duration !== undefined) {
      const durationCommand = side === 'left'
        ? HardwareCommand.LEFT_TEMP_DURATION
        : HardwareCommand.RIGHT_TEMP_DURATION

      await sendCommand(durationCommand, duration.toString())
    }
  }

  async setAlarm(side: Side, config: AlarmConfig): Promise<void> {
    if (config.vibrationIntensity < 1 || config.vibrationIntensity > 100) {
      throw new HardwareError('Vibration intensity must be between 1 and 100')
    }
    if (config.duration < 0 || config.duration > 180) {
      throw new HardwareError('Alarm duration must be between 0 and 180 seconds')
    }

    const command = side === 'left' ? HardwareCommand.ALARM_LEFT : HardwareCommand.ALARM_RIGHT
    const patternCode = config.vibrationPattern === 'double' ? '0' : '1'
    const argument = `${config.vibrationIntensity},${patternCode},${config.duration}`

    const response = await sendCommand(command, argument)
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
      const temp = temperature ?? 75
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

  disconnect(): void {
    // No-op for shared client — disconnectDac() is called at shutdown.
    // Individual consumers should not tear down the shared connection.
  }

  getRawClient(): null {
    return null
  }
}

// ── Shared HardwareClient ──

export function getSharedHardwareClient(): HardwareClient {
  if (g[KEYS.client]) return g[KEYS.client] as HardwareClient

  // Return a DacHardwareClient cast as HardwareClient.
  // It implements the same interface (duck typing).
  const client = new DacHardwareClient() as unknown as HardwareClient
  g[KEYS.client] = client
  return client
}

// ── DacMonitor ──

let monitorInitPromise: Promise<DacMonitor> | null = null

export const getDacMonitor = async (): Promise<DacMonitor> => {
  if (g[KEYS.monitor]) return g[KEYS.monitor] as DacMonitor
  if (monitorInitPromise) return monitorInitPromise

  monitorInitPromise = (async () => {
    try {
      const hwClient = getSharedHardwareClient()
      const monitor = new DacMonitor({ socketPath: DAC_SOCK_PATH, hardwareClient: hwClient })
      const gestureHandler = new GestureActionHandler(DAC_SOCK_PATH, defaultGestureActionDeps)
      const stateSync = new DeviceStateSync()

      monitor.on('gesture:detected', event => gestureHandler.handle(event))
      monitor.on('status:updated', (status) => {
        stateSync.sync(status).catch(err =>
          console.error('[DacMonitor] DeviceStateSync error:', err)
        )
      })

      g[KEYS.monitor] = monitor
      g[KEYS.gesture] = gestureHandler

      await monitor.start()
      console.log('[DAC] monitor started')

      return monitor
    }
    catch (error) {
      g[KEYS.monitor] = null
      g[KEYS.gesture] = null
      throw error
    }
    finally {
      monitorInitPromise = null
    }
  })()

  return monitorInitPromise
}

export const getDacMonitorIfRunning = (): DacMonitor | null =>
  (g[KEYS.monitor] as DacMonitor) ?? null

export const shutdownDacMonitor = async (): Promise<void> => {
  if (monitorInitPromise) {
    try {
      await monitorInitPromise
    }
    catch { /* ok */ }
  }

  const monitor = g[KEYS.monitor] as DacMonitor | undefined
  const gestureHandler = g[KEYS.gesture] as GestureActionHandler | undefined

  g[KEYS.monitor] = null
  g[KEYS.gesture] = null
  g[KEYS.client] = null
  g[KEYS.server] = null
  monitorInitPromise = null

  gestureHandler?.cleanup()

  if (monitor) {
    monitor.removeAllListeners('gesture:detected')
    monitor.removeAllListeners('status:updated')
    monitor.stop()
  }

  await disconnectDac()

  console.log('[DAC] shutdown complete')
}
