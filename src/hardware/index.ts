/**
 * Hardware abstraction layer for Eight Sleep Pod control.
 *
 * This module provides a type-safe, high-level interface for communicating
 * with the pod hardware via Unix socket. All low-level details are abstracted
 * away, providing a clean API for temperature control, alarms, and device status.
 *
 * @example
 * ```typescript
 * import { createHardwareClient } from './hardware'
 *
 * const client = await createHardwareClient({
 *   socketPath: '/run/dac.sock'
 * })
 *
 * // Get device status
 * const status = await client.getDeviceStatus()
 * console.log(status.leftSide.currentTemperature)
 *
 * // Set temperature
 * await client.setTemperature('left', 75)
 *
 * // Set alarm
 * await client.setAlarm('right', {
 *   vibrationIntensity: 50,
 *   vibrationPattern: 'rise',
 *   duration: 120
 * })
 * ```
 */

export { HardwareClient, createHardwareClient, type HardwareClientConfig } from './client'
export { MessageStream } from './messageStream'
export { parseDeviceStatus, decodeSettings, parseSimpleResponse } from './responseParser'
export { SequentialQueue } from './sequentialQueue'
export { SocketClient, connectToSocket } from './socketClient'
export {
  HardwareCommand,
  PodVersion,
  HardwareError,
  ConnectionTimeoutError,
  CommandExecutionError,
  ParseError,
  levelToFahrenheit,
  fahrenheitToLevel,
  type Side,
  type DeviceStatus,
  type SideStatus,
  type GestureData,
  type AlarmConfig,
  type RawDeviceData,
} from './types'
