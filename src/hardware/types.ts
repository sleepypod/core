import { z } from 'zod'

/**
 * Hardware command types
 */
export enum HardwareCommand {
  HELLO = '0',
  SET_TEMP = '1',
  SET_ALARM = '2',
  ALARM_LEFT = '5',
  ALARM_RIGHT = '6',
  SET_SETTINGS = '8',
  LEFT_TEMP_DURATION = '9',
  RIGHT_TEMP_DURATION = '10',
  TEMP_LEVEL_LEFT = '11',
  TEMP_LEVEL_RIGHT = '12',
  PRIME = '13',
  DEVICE_STATUS = '14',
  ALARM_CLEAR = '16',
}

/**
 * Pod hardware versions
 */
export enum PodVersion {
  POD_3 = 'H00',
  POD_4 = 'I00',
  POD_5 = 'J00',
}

/**
 * Side identifiers
 */
export type Side = 'left' | 'right'

/**
 * Raw device status response from hardware
 */
export const rawDeviceDataSchema = z.object({
  tgHeatLevelR: z.string().regex(/-?\d+/),
  tgHeatLevelL: z.string().regex(/-?\d+/),
  heatTimeL: z.string().regex(/^\d+/),
  heatLevelL: z.string().regex(/-?\d+/),
  heatTimeR: z.string().regex(/^\d+/),
  heatLevelR: z.string().regex(/-?\d+/),
  sensorLabel: z.string(),
  waterLevel: z.enum(['true', 'false']),
  priming: z.enum(['true', 'false']),
  settings: z.string().optional(),
  // Gesture support (Pod 4+)
  doubleTap: z.string().optional(),
  tripleTap: z.string().optional(),
  quadTap: z.string().optional(),
})

export type RawDeviceData = z.infer<typeof rawDeviceDataSchema>

/**
 * Parsed gesture data
 */
export interface GestureData {
  doubleTap?: { l: number; r: number }
  tripleTap?: { l: number; r: number }
  quadTap?: { l: number; r: number }
}

/**
 * Structured device status
 */
export interface DeviceStatus {
  leftSide: SideStatus
  rightSide: SideStatus
  waterLevel: 'low' | 'ok'
  isPriming: boolean
  podVersion: PodVersion
  sensorLabel: string
  gestures?: GestureData
}

/**
 * Individual side status
 */
export interface SideStatus {
  currentTemperature: number // In Fahrenheit
  targetTemperature: number // In Fahrenheit
  currentLevel: number // -100 to 100
  targetLevel: number // -100 to 100
  heatingDuration: number // In seconds
}

/**
 * Temperature conversion utilities
 */
export const TEMP_NEUTRAL = 82.5 // Level 0 = 82.5°F
export const TEMP_RANGE = 27.5 // ±27.5°F from neutral
export const MIN_TEMP = 55 // °F
export const MAX_TEMP = 110 // °F
export const MIN_LEVEL = -100
export const MAX_LEVEL = 100

/**
 * Convert temperature level (-100 to 100) to Fahrenheit
 */
export function levelToFahrenheit(level: number): number {
  return Math.round(TEMP_NEUTRAL + (level / 100) * TEMP_RANGE)
}

/**
 * Convert Fahrenheit to temperature level (-100 to 100)
 */
export function fahrenheitToLevel(temp: number): number {
  return Math.round(((temp - TEMP_NEUTRAL) / TEMP_RANGE) * 100)
}

/**
 * Alarm configuration
 */
export interface AlarmConfig {
  vibrationIntensity: number // 1-100
  vibrationPattern: 'double' | 'rise'
  duration: number // 0-180 seconds
}

/**
 * Hardware errors
 */
export class HardwareError extends Error {
  constructor(
    message: string,
    public readonly code?: string
  ) {
    super(message)
    this.name = 'HardwareError'
  }
}

export class ConnectionTimeoutError extends HardwareError {
  constructor(message = 'Hardware connection timeout') {
    super(message, 'CONNECTION_TIMEOUT')
    this.name = 'ConnectionTimeoutError'
  }
}

export class CommandExecutionError extends HardwareError {
  constructor(
    message: string,
    public readonly command: HardwareCommand
  ) {
    super(message, 'COMMAND_EXECUTION_FAILED')
    this.name = 'CommandExecutionError'
  }
}

export class ParseError extends HardwareError {
  constructor(
    message: string,
    public readonly rawData?: string
  ) {
    super(message, 'PARSE_ERROR')
    this.name = 'ParseError'
  }
}
