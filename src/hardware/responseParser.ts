import { decode as cborDecode } from 'cbor-x'
import {
  type DeviceStatus,
  type GestureData,
  type RawDeviceData,
  ParseError,
  PodVersion,
  levelToFahrenheit,
  rawDeviceDataSchema,
} from './types'

/**
 * Parse raw device status response into structured format.
 */
export function parseDeviceStatus(response: string): DeviceStatus {
  try {
    // Split response into lines and parse key-value pairs
    const raw = parseKeyValueResponse(response)

    // Validate schema
    const validated = rawDeviceDataSchema.parse(raw)

    // Extract pod version from sensor label
    const podVersion = extractPodVersion(validated.sensorLabel)

    // Parse gesture data if available
    const gestures = parseGestures(validated)

    // Build structured status
    return {
      leftSide: {
        currentTemperature: levelToFahrenheit(Number(validated.heatLevelL)),
        targetTemperature: levelToFahrenheit(Number(validated.tgHeatLevelL)),
        currentLevel: Number(validated.heatLevelL),
        targetLevel: Number(validated.tgHeatLevelL),
        heatingDuration: Number(validated.heatTimeL),
      },
      rightSide: {
        currentTemperature: levelToFahrenheit(Number(validated.heatLevelR)),
        targetTemperature: levelToFahrenheit(Number(validated.tgHeatLevelR)),
        currentLevel: Number(validated.heatLevelR),
        targetLevel: Number(validated.tgHeatLevelR),
        heatingDuration: Number(validated.heatTimeR),
      },
      waterLevel: validated.waterLevel === 'true' ? 'ok' : 'low',
      isPriming: validated.priming === 'true',
      podVersion,
      sensorLabel: validated.sensorLabel,
      gestures,
    }
  }
  catch (error) {
    throw new ParseError(
      `Failed to parse device status: ${error}`,
      response
    )
  }
}

/**
 * Parse key-value response format.
 * Example: "key1 = value1\nkey2 = value2"
 */
function parseKeyValueResponse(response: string): Record<string, string> {
  const result: Record<string, string> = {}

  const lines = response.split('\n').filter(line => line.trim())

  for (const line of lines) {
    // Split only on first ' = ' to handle values containing ' = '
    const separatorIndex = line.indexOf(' = ')
    if (separatorIndex !== -1) {
      const key = line.substring(0, separatorIndex).trim()
      const value = line.substring(separatorIndex + 3).trim()
      result[key] = value
    }
  }

  return result
}

/**
 * Extract pod version from sensor label.
 * Example: "8SLEEP-SN-12345-H00" -> Pod 3
 */
function extractPodVersion(sensorLabel: string): PodVersion {
  const hwRev = sensorLabel.split('-').pop() || ''

  if (hwRev >= 'J00') {
    return PodVersion.POD_5
  }
  else if (hwRev >= 'I00') {
    return PodVersion.POD_4
  }
  else if (hwRev >= 'H00') {
    return PodVersion.POD_3
  }

  return PodVersion.POD_3
}

/**
 * Parse gesture data from raw response.
 */
function parseGestures(raw: RawDeviceData): GestureData | undefined {
  try {
    const gestures: GestureData = {}

    if (raw.doubleTap) {
      gestures.doubleTap = JSON.parse(raw.doubleTap)
    }

    if (raw.tripleTap) {
      gestures.tripleTap = JSON.parse(raw.tripleTap)
    }

    if (raw.quadTap) {
      gestures.quadTap = JSON.parse(raw.quadTap)
    }

    return Object.keys(gestures).length > 0 ? gestures : undefined
  }
  catch (error) {
    console.warn('Failed to parse gesture data:', error)
    return undefined
  }
}

/**
 * Decode CBOR settings data.
 */
export function decodeSettings(hexString: string): Record<string, unknown> {
  try {
    const buffer = Buffer.from(hexString, 'hex')
    return cborDecode(buffer) as Record<string, unknown>
  }
  catch (error) {
    throw new ParseError(`Failed to decode CBOR settings: ${error}`)
  }
}

/**
 * Parse a simple response (e.g., "OK" or error message).
 */
export function parseSimpleResponse(response: string): { success: boolean, message: string } {
  const trimmed = response.trim()

  if (trimmed === 'OK' || trimmed === '') {
    return { success: true, message: 'OK' }
  }

  // Check for error patterns
  if (trimmed.toLowerCase().includes('error') || trimmed.toLowerCase().includes('fail')) {
    return { success: false, message: trimmed }
  }

  return { success: true, message: trimmed }
}
