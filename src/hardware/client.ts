import { connectToSocket, type SocketClient } from './socketClient'
import { parseDeviceStatus, parseSimpleResponse } from './responseParser'
import {
  type AlarmConfig,
  type DeviceStatus,
  type Side,
  HardwareCommand,
  HardwareError,
  fahrenheitToLevel,
} from './types'

/**
 * Configuration for hardware client.
 */
export interface HardwareClientConfig {
  socketPath: string
  connectionTimeout?: number
  autoReconnect?: boolean
}

/**
 * High-level hardware client for pod control.
 * Provides type-safe interface for all pod operations.
 */
export class HardwareClient {
  private client: SocketClient | null = null
  private readonly config: Required<HardwareClientConfig>

  constructor(config: HardwareClientConfig) {
    this.config = {
      connectionTimeout: 25000,
      autoReconnect: true,
      ...config,
    }
  }

  /**
   * Connect to hardware daemon.
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

      // Send hello command to verify connection
      await this.client.executeCommand(HardwareCommand.HELLO)
    } catch (error) {
      this.client = null
      throw new HardwareError(`Failed to connect to hardware: ${error}`)
    }
  }

  /**
   * Ensure client is connected, reconnecting if necessary.
   */
  private async ensureConnected(): Promise<SocketClient> {
    if (!this.client || this.client.isClosed()) {
      if (this.config.autoReconnect) {
        await this.connect()
      } else {
        throw new HardwareError('Not connected to hardware')
      }
    }

    return this.client!
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
   * Set temperature for a side.
   * @param side - 'left' or 'right'
   * @param temperature - Temperature in Fahrenheit (55-110)
   * @param duration - Duration in seconds (optional)
   */
  async setTemperature(
    side: Side,
    temperature: number,
    duration?: number
  ): Promise<void> {
    const client = await this.ensureConnected()

    // Validate temperature range
    if (temperature < 55 || temperature > 110) {
      throw new HardwareError(`Temperature must be between 55°F and 110°F`)
    }

    // Convert Fahrenheit to level
    const level = fahrenheitToLevel(temperature)

    // Set temperature level
    const levelCommand =
      side === 'left'
        ? HardwareCommand.TEMP_LEVEL_LEFT
        : HardwareCommand.TEMP_LEVEL_RIGHT

    await client.executeCommand(levelCommand, level.toString())

    // Set duration if provided
    if (duration !== undefined) {
      const durationCommand =
        side === 'left'
          ? HardwareCommand.LEFT_TEMP_DURATION
          : HardwareCommand.RIGHT_TEMP_DURATION

      await client.executeCommand(durationCommand, duration.toString())
    }
  }

  /**
   * Set alarm for a side.
   * @param side - 'left' or 'right'
   * @param config - Alarm configuration
   */
  async setAlarm(side: Side, config: AlarmConfig): Promise<void> {
    const client = await this.ensureConnected()

    // Validate intensity
    if (config.vibrationIntensity < 1 || config.vibrationIntensity > 100) {
      throw new HardwareError('Vibration intensity must be between 1 and 100')
    }

    // Validate duration
    if (config.duration < 0 || config.duration > 180) {
      throw new HardwareError('Alarm duration must be between 0 and 180 seconds')
    }

    const command = side === 'left' ? HardwareCommand.ALARM_LEFT : HardwareCommand.ALARM_RIGHT

    // Format: "intensity,pattern,duration"
    const patternCode = config.vibrationPattern === 'double' ? '0' : '1'
    const argument = `${config.vibrationIntensity},${patternCode},${config.duration}`

    const response = await client.executeCommand(command, argument)
    const parsed = parseSimpleResponse(response)

    if (!parsed.success) {
      throw new HardwareError(`Failed to set alarm: ${parsed.message}`)
    }
  }

  /**
   * Clear/stop alarm for a side.
   */
  async clearAlarm(side: Side): Promise<void> {
    const client = await this.ensureConnected()
    await client.executeCommand(HardwareCommand.ALARM_CLEAR, side === 'left' ? '0' : '1')
  }

  /**
   * Start pod priming sequence.
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
   * Power on/off a side.
   * @param side - 'left' or 'right'
   * @param powered - true to power on, false to power off
   * @param temperature - Target temperature when powering on (optional)
   */
  async setPower(side: Side, powered: boolean, temperature?: number): Promise<void> {
    if (powered) {
      // Power on by setting temperature
      const temp = temperature ?? 75 // Default to 75°F
      await this.setTemperature(side, temp)
    } else {
      // Power off by setting level to 0
      const client = await this.ensureConnected()
      const command =
        side === 'left' ? HardwareCommand.TEMP_LEVEL_LEFT : HardwareCommand.TEMP_LEVEL_RIGHT
      await client.executeCommand(command, '0')
    }
  }

  /**
   * Check if client is connected.
   */
  isConnected(): boolean {
    return this.client !== null && !this.client.isClosed()
  }

  /**
   * Disconnect from hardware.
   */
  disconnect(): void {
    if (this.client) {
      this.client.close()
      this.client = null
    }
  }

  /**
   * Get raw socket client for advanced operations.
   */
  getRawClient(): SocketClient | null {
    return this.client
  }
}

/**
 * Create and connect a hardware client.
 */
export async function createHardwareClient(
  config: HardwareClientConfig
): Promise<HardwareClient> {
  const client = new HardwareClient(config)
  await client.connect()
  return client
}
