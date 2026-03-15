import { connectToSocket, type SocketClient } from './socketClient'
import { parseDeviceStatus, parseSimpleResponse } from './responseParser'
import {
  type AlarmConfig,
  type DeviceStatus,
  type Side,
  HardwareCommand,
  HardwareError,
  DEFAULT_HEATING_DURATION,
  fahrenheitToLevel,
  MAX_TEMP,
  MIN_TEMP,
} from './types'

/**
 * Configuration for the hardware client connection.
 *
 * This is the CLIENT-mode connection (for dev/testing only).
 * In production, use FrankenHardwareClient from dacMonitor.instance.ts instead,
 * which uses the FrankenServer pattern (socket server that frankenfirmware connects to).
 *
 * @property socketPath - Path to Unix socket to connect to
 * @property connectionTimeout - Max milliseconds to wait for connection (default: 30s)
 * @property autoReconnect - Whether to automatically reconnect on connection loss (default: true)
 */
export interface HardwareClientConfig {
  socketPath: string
  connectionTimeout?: number
  autoReconnect?: boolean
}

/**
 * High-level hardware client for Eight Sleep Pod control.
 *
 * Provides a type-safe API for all pod operations including temperature control,
 * alarms, and status monitoring. Handles connection management, command queuing,
 * and automatic reconnection.
 *
 * Key Features:
 * - Sequential command execution (prevents hardware race conditions)
 * - Automatic reconnection on connection loss
 * - Type-safe commands with validation
 * - Temperature unit conversion (Fahrenheit ↔ hardware levels)
 *
 * Thread Safety: Safe for concurrent calls - commands are internally queued
 * and executed sequentially.
 *
 * Protocol: Communicates via Unix socket using newline-delimited text protocol.
 * Each command is "{code}\n{argument}\n\n" and responses are text or key=value pairs.
 *
 * @example
 * ```typescript
 * const client = new HardwareClient({
 *   socketPath: '/run/dac.sock',
 *   autoReconnect: true
 * })
 *
 * await client.connect()
 * await client.setTemperature('left', 72)
 * const status = await client.getDeviceStatus()
 * ```
 */
export class HardwareClient {
  private client: SocketClient | null = null
  private readonly config: Required<HardwareClientConfig>

  constructor(config: HardwareClientConfig) {
    this.config = {
      connectionTimeout: 30000,
      autoReconnect: true,
      ...config,
    }
  }

  /**
   * Connects TO an existing Unix socket as a client.
   *
   * This is for dev/testing only. In production, use FrankenHardwareClient
   * from dacMonitor.instance.ts which uses the FrankenServer pattern.
   */
  async connect(): Promise<void> {
    if (this.client && !this.client.isClosed()) {
      return
    }

    try {
      this.client = await connectToSocket(
        this.config.socketPath,
        this.config.connectionTimeout
      )
    }
    catch (error) {
      this.client = null
      throw new HardwareError(`Failed to connect to hardware: ${error}`)
    }
  }

  /**
   * Ensures a valid connection exists before executing commands.
   *
   * Behavior depends on autoReconnect config:
   * - If autoReconnect=true: Attempts to reconnect if connection is lost
   * - If autoReconnect=false: Throws HardwareError immediately
   *
   * Connection is considered lost if:
   * - client is null (never connected or explicitly disconnected)
   * - client.isClosed() returns true (socket closed by hardware or error)
   *
   * @returns Valid SocketClient ready for command execution
   * @throws {HardwareError} If not connected and autoReconnect is disabled
   * @throws {HardwareError} If reconnection attempt fails
   */
  private async ensureConnected(): Promise<SocketClient> {
    if (!this.client || this.client.isClosed()) {
      if (this.config.autoReconnect) {
        await this.connect()
      }
      else {
        throw new HardwareError('Not connected to hardware')
      }
    }

    if (!this.client) {
      throw new HardwareError('Client connection failed')
    }

    return this.client
  }

  /**
   * Get current device status.
   */
  async getDeviceStatus(): Promise<DeviceStatus> {
    const client = await this.ensureConnected()
    const response = await client.executeCommand(HardwareCommand.DEVICE_STATUS)
    return parseDeviceStatus(response)
  }

  /**
   * Sets the target temperature for a pod side.
   *
   * Temperature changes are applied immediately but the physical heating/cooling
   * process takes time. The pod heats/cools at approximately 1-2°F per minute.
   * Poll getDeviceStatus() to monitor actual temperature changes.
   *
   * Hardware Behavior:
   * - Temperature is converted to a level (-100 to 100) before sending
   * - Level 0 = 82.5°F (neutral), -100 = 55°F (cool), +100 = 110°F (warm)
   * - If duration is set, pod automatically returns to neutral after timeout
   * - If duration is omitted, defaults to 28800 seconds (8 hours)
   *
   * @param side - Which side of the pod ('left' or 'right')
   * @param temperature - Target temperature in Fahrenheit (55-110°F range)
   * @param duration - Optional duration in seconds to maintain temperature
   * @throws {HardwareError} If temperature out of valid range (55-110°F)
   * @throws {ConnectionError} If not connected to hardware
   *
   * @example
   * ```typescript
   * // Set left side to 72°F for the default 8-hour duration
   * await client.setTemperature('left', 72)
   *
   * // Set right side to 65°F for 30 minutes (1800 seconds)
   * await client.setTemperature('right', 65, 1800)
   * ```
   */
  async setTemperature(
    side: Side,
    temperature: number,
    duration?: number
  ): Promise<void> {
    const client = await this.ensureConnected()

    // Validate against hardware's physical limits (heating/cooling capacity)
    if (temperature < MIN_TEMP || temperature > MAX_TEMP) {
      throw new HardwareError(`Temperature must be between ${MIN_TEMP}°F and ${MAX_TEMP}°F`)
    }

    // Convert Fahrenheit to hardware's internal level scale (-100 to 100)
    const level = fahrenheitToLevel(temperature)

    // Set temperature level for the specified side
    const levelCommand
      = side === 'left'
        ? HardwareCommand.TEMP_LEVEL_LEFT
        : HardwareCommand.TEMP_LEVEL_RIGHT

    await client.executeCommand(levelCommand, level.toString())

    // Set duration — default to 8 hours if not specified so the pod actually heats
    const durationCommand
      = side === 'left'
        ? HardwareCommand.LEFT_TEMP_DURATION
        : HardwareCommand.RIGHT_TEMP_DURATION

    await client.executeCommand(durationCommand, (duration ?? DEFAULT_HEATING_DURATION).toString())
  }

  /**
   * Configures and activates the vibration alarm for a pod side.
   *
   * The alarm starts vibrating immediately upon successful execution. To schedule
   * an alarm for a future time, use the scheduling layer instead of calling this
   * directly.
   *
   * Vibration Patterns:
   * - 'double': Two quick bursts (good for light sleepers)
   * - 'rise': Gradually increasing intensity (gentle wake-up)
   *
   * Hardware Limits:
   * - Intensity: 1-100 (hardware limitation, not arbitrary)
   * - Duration: 0-180 seconds max (3 minutes, firmware-enforced)
   * - Only one alarm can be active per side at a time
   *
   * @param side - Which side of the pod ('left' or 'right')
   * @param config - Alarm configuration (intensity, pattern, duration)
   * @throws {HardwareError} If intensity not in 1-100 range
   * @throws {HardwareError} If duration not in 0-180 second range
   * @throws {HardwareError} If hardware rejects the alarm configuration
   *
   * @example
   * ```typescript
   * // Gentle rising alarm for 60 seconds at 50% intensity
   * await client.setAlarm('left', {
   *   vibrationIntensity: 50,
   *   vibrationPattern: 'rise',
   *   duration: 60
   * })
   * ```
   */
  async setAlarm(side: Side, config: AlarmConfig): Promise<void> {
    const client = await this.ensureConnected()

    // Validate against hardware's vibration motor capabilities
    if (config.vibrationIntensity < 1 || config.vibrationIntensity > 100) {
      throw new HardwareError('Vibration intensity must be between 1 and 100')
    }

    // Firmware limits alarm duration to 180 seconds to prevent motor damage
    if (config.duration < 0 || config.duration > 180) {
      throw new HardwareError('Alarm duration must be between 0 and 180 seconds')
    }

    const command = side === 'left' ? HardwareCommand.ALARM_LEFT : HardwareCommand.ALARM_RIGHT

    // Hardware protocol: "intensity,pattern,duration"
    // Pattern encoding: 0 = double burst, 1 = rising intensity
    const patternCode = config.vibrationPattern === 'double' ? '0' : '1'
    const argument = `${config.vibrationIntensity},${patternCode},${config.duration}`

    const response = await client.executeCommand(command, argument)
    const parsed = parseSimpleResponse(response)

    if (!parsed.success) {
      throw new HardwareError(`Failed to set alarm: ${parsed.message}`)
    }
  }

  /**
   * Stops the vibration alarm for a pod side.
   *
   * Safe to call even if no alarm is currently active - hardware ignores
   * redundant clear commands.
   *
   * @param side - Which side alarm to clear ('left' or 'right')
   */
  async clearAlarm(side: Side): Promise<void> {
    const client = await this.ensureConnected()
    // Hardware protocol: 0 = left, 1 = right
    await client.executeCommand(HardwareCommand.ALARM_CLEAR, side === 'left' ? '0' : '1')
  }

  /**
   * Initiates the pod water system priming sequence.
   *
   * Priming circulates water through the system to remove air bubbles and
   * ensure proper thermal performance. This should be run:
   * - After initial pod setup
   * - When water level indicator shows low
   * - After extended periods of non-use (>1 week)
   *
   * Duration: Typically completes in 2-5 minutes. Poll getDeviceStatus()
   * to check isPriming field for completion.
   *
   * Warning: Do not run priming while someone is lying on the pod - it can
   * be loud and cause vibrations.
   *
   * @throws {HardwareError} If hardware rejects priming command (e.g., already priming)
   */
  async startPriming(): Promise<void> {
    const client = await this.ensureConnected()
    const response = await client.executeCommand(HardwareCommand.PRIME)
    const parsed = parseSimpleResponse(response)

    if (!parsed.success) {
      throw new HardwareError(`Failed to start priming: ${parsed.message}`)
    }
  }

  /**
   * Powers a pod side on or off.
   *
   * Power State Behavior:
   * - ON: Sets temperature (default 75°F) and activates heating/cooling
   * - OFF: Sets temperature level to 0 (neutral/82.5°F), stops active heating/cooling
   *
   * Note: There is no true "off" state in the hardware. Setting level to 0
   * achieves the same effect by stopping thermal regulation.
   *
   * @param side - Which side to control ('left' or 'right')
   * @param powered - true to power on, false to power off
   * @param temperature - Target temperature when powering on (default: 75°F)
   *
   * @example
   * ```typescript
   * // Power on left side at 70°F
   * await client.setPower('left', true, 70)
   *
   * // Power off right side
   * await client.setPower('right', false)
   * ```
   */
  async setPower(side: Side, powered: boolean, temperature?: number): Promise<void> {
    if (powered) {
      // Power on by setting target temperature
      const temp = temperature ?? 75 // 75°F is a comfortable default
      await this.setTemperature(side, temp)
    }
    else {
      // Power off by setting level to 0 (neutral, no heating/cooling)
      const client = await this.ensureConnected()
      const command
        = side === 'left' ? HardwareCommand.TEMP_LEVEL_LEFT : HardwareCommand.TEMP_LEVEL_RIGHT
      const response = await client.executeCommand(command, '0')
      const parsed = parseSimpleResponse(response)

      if (!parsed.success) {
        throw new HardwareError(`Failed to power off: ${parsed.message}`)
      }
    }
  }

  /**
   * Checks current connection status.
   *
   * Returns false if:
   * - Never connected (client is null)
   * - Explicitly disconnected via disconnect()
   * - Connection lost due to hardware error or network issue
   *
   * Note: This only checks local state. It does NOT ping the hardware
   * to verify the connection is still alive.
   *
   * @returns true if connected, false otherwise
   */
  isConnected(): boolean {
    return this.client !== null && !this.client.isClosed()
  }

  /**
   * Closes the connection to the hardware daemon.
   *
   * Behavior:
   * - Closes the Unix socket immediately
   * - Does NOT wait for pending commands (they will fail)
   * - Idempotent - safe to call multiple times
   * - Disables auto-reconnect until connect() is called again
   *
   * Use this when:
   * - Shutting down the application
   * - Switching to a different hardware connection
   * - Need to force a fresh connection
   *
   * For graceful shutdown with pending commands, ensure all promises
   * are resolved before calling disconnect().
   */
  disconnect(): void {
    if (this.client) {
      this.client.close()
      this.client = null
    }
  }

  /**
   * Provides access to the underlying socket client for advanced use cases.
   *
   * WARNING: Direct socket access bypasses the high-level client's protections:
   * - Command queuing (can cause race conditions)
   * - Auto-reconnection logic
   * - Temperature unit conversion
   * - Input validation
   *
   * Only use this if you need to:
   * - Implement custom hardware commands not in the API
   * - Debug low-level protocol issues
   * - Access socket-level events
   *
   * @returns The raw SocketClient, or null if not connected
   */
  getRawClient(): SocketClient | null {
    return this.client
  }
}

/**
 * Factory function to create and connect a hardware client in one step.
 *
 * Convenience wrapper that combines client instantiation and connection.
 * Equivalent to:
 * ```typescript
 * const client = new HardwareClient(config)
 * await client.connect()
 * return client
 * ```
 *
 * @param config - Hardware client configuration
 * @returns Connected HardwareClient ready for use
 * @throws {HardwareError} If connection fails
 * @throws {ConnectionTimeoutError} If connection times out
 *
 * @example
 * ```typescript
 * const client = await createHardwareClient({
 *   socketPath: '/run/dac.sock',
 *   autoReconnect: true
 * })
 * ```
 */
export async function createHardwareClient(
  config: HardwareClientConfig
): Promise<HardwareClient> {
  const client = new HardwareClient(config)
  await client.connect()
  return client
}
