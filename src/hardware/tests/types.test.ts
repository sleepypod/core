import { describe, expect, test } from 'vitest'
import {
  type AlarmConfig,
  CommandExecutionError,
  ConnectionTimeoutError,
  HardwareCommand,
  HardwareError,
  MAX_LEVEL,
  MAX_TEMP,
  MIN_LEVEL,
  MIN_TEMP,
  ParseError,
  PodVersion,
  TEMP_NEUTRAL,
  TEMP_RANGE,
  fahrenheitToLevel,
  levelToFahrenheit,
  rawDeviceDataSchema,
} from '../types'

describe('Temperature Conversion', () => {
  describe('levelToFahrenheit', () => {
    test('converts neutral level (0) to neutral temp', () => {
      expect(levelToFahrenheit(0)).toBe(Math.round(TEMP_NEUTRAL))
    })

    test('converts min level (-100) to min temp', () => {
      expect(levelToFahrenheit(MIN_LEVEL)).toBe(MIN_TEMP)
    })

    test('converts max level (100) to max temp', () => {
      expect(levelToFahrenheit(MAX_LEVEL)).toBe(MAX_TEMP)
    })

    test('converts positive levels correctly', () => {
      expect(levelToFahrenheit(50)).toBe(Math.round(TEMP_NEUTRAL + TEMP_RANGE * 0.5))
      expect(levelToFahrenheit(25)).toBe(Math.round(TEMP_NEUTRAL + TEMP_RANGE * 0.25))
    })

    test('converts negative levels correctly', () => {
      expect(levelToFahrenheit(-50)).toBe(Math.round(TEMP_NEUTRAL - TEMP_RANGE * 0.5))
      expect(levelToFahrenheit(-25)).toBe(Math.round(TEMP_NEUTRAL - TEMP_RANGE * 0.25))
    })

    test('rounds to nearest integer', () => {
      const result = levelToFahrenheit(13) // Should produce non-integer before rounding
      expect(Number.isInteger(result)).toBe(true)
    })
  })

  describe('fahrenheitToLevel', () => {
    test('converts neutral temp to neutral level', () => {
      // TEMP_NEUTRAL is 82.5°F, which rounds to 83°F
      // 83°F converts to level 2 due to rounding
      const result = fahrenheitToLevel(Math.round(TEMP_NEUTRAL))
      expect(Math.abs(result)).toBeLessThanOrEqual(2)
    })

    test('converts min temp to min level', () => {
      expect(fahrenheitToLevel(MIN_TEMP)).toBe(MIN_LEVEL)
    })

    test('converts max temp to max level', () => {
      expect(fahrenheitToLevel(MAX_TEMP)).toBe(MAX_LEVEL)
    })

    test('converts warm temps to positive levels', () => {
      expect(fahrenheitToLevel(96)).toBeGreaterThan(0)
      expect(fahrenheitToLevel(110)).toBe(100)
    })

    test('converts cool temps to negative levels', () => {
      expect(fahrenheitToLevel(70)).toBeLessThan(0)
      expect(fahrenheitToLevel(55)).toBe(-100)
    })

    test('rounds to nearest integer', () => {
      const result = fahrenheitToLevel(88)
      expect(Number.isInteger(result)).toBe(true)
    })
  })

  describe('round-trip conversion', () => {
    test('level -> temp -> level preserves value', () => {
      for (let level = MIN_LEVEL; level <= MAX_LEVEL; level += 10) {
        const temp = levelToFahrenheit(level)
        const backToLevel = fahrenheitToLevel(temp)
        // Allow ±2 due to rounding (especially near neutral)
        expect(Math.abs(backToLevel - level)).toBeLessThanOrEqual(2)
      }
    })

    test('temp -> level -> temp preserves value', () => {
      for (let temp = MIN_TEMP; temp <= MAX_TEMP; temp += 5) {
        const level = fahrenheitToLevel(temp)
        const backToTemp = levelToFahrenheit(level)
        // Allow ±1 due to rounding
        expect(Math.abs(backToTemp - temp)).toBeLessThanOrEqual(1)
      }
    })
  })
})

describe('Enums', () => {
  describe('HardwareCommand', () => {
    test('has all required commands', () => {
      expect(HardwareCommand.HELLO).toBe('0')
      expect(HardwareCommand.SET_TEMP).toBe('1')
      expect(HardwareCommand.SET_ALARM).toBe('2')
      expect(HardwareCommand.ALARM_LEFT).toBe('5')
      expect(HardwareCommand.ALARM_RIGHT).toBe('6')
      expect(HardwareCommand.SET_SETTINGS).toBe('8')
      expect(HardwareCommand.LEFT_TEMP_DURATION).toBe('9')
      expect(HardwareCommand.RIGHT_TEMP_DURATION).toBe('10')
      expect(HardwareCommand.TEMP_LEVEL_LEFT).toBe('11')
      expect(HardwareCommand.TEMP_LEVEL_RIGHT).toBe('12')
      expect(HardwareCommand.PRIME).toBe('13')
      expect(HardwareCommand.DEVICE_STATUS).toBe('14')
      expect(HardwareCommand.ALARM_CLEAR).toBe('16')
    })
  })

  describe('PodVersion', () => {
    test('has all pod versions', () => {
      expect(PodVersion.POD_3).toBe('H00')
      expect(PodVersion.POD_4).toBe('I00')
      expect(PodVersion.POD_5).toBe('J00')
    })

    test('versions are sortable', () => {
      const versions = [PodVersion.POD_5, PodVersion.POD_3, PodVersion.POD_4]
      versions.sort()
      expect(versions).toEqual([PodVersion.POD_3, PodVersion.POD_4, PodVersion.POD_5])
    })
  })
})

describe('Error Classes', () => {
  describe('HardwareError', () => {
    test('creates error with message', () => {
      const error = new HardwareError('Test error')
      expect(error.message).toBe('Test error')
      expect(error.name).toBe('HardwareError')
      expect(error.code).toBeUndefined()
    })

    test('creates error with code', () => {
      const error = new HardwareError('Test error', 'TEST_CODE')
      expect(error.message).toBe('Test error')
      expect(error.code).toBe('TEST_CODE')
    })

    test('is instanceof Error', () => {
      const error = new HardwareError('Test')
      expect(error instanceof Error).toBe(true)
      expect(error instanceof HardwareError).toBe(true)
    })
  })

  describe('ConnectionTimeoutError', () => {
    test('creates error with default message', () => {
      const error = new ConnectionTimeoutError()
      expect(error.message).toBe('Hardware connection timeout')
      expect(error.name).toBe('ConnectionTimeoutError')
      expect(error.code).toBe('CONNECTION_TIMEOUT')
    })

    test('creates error with custom message', () => {
      const error = new ConnectionTimeoutError('Custom timeout')
      expect(error.message).toBe('Custom timeout')
    })

    test('is instanceof HardwareError', () => {
      const error = new ConnectionTimeoutError()
      expect(error instanceof HardwareError).toBe(true)
    })
  })

  describe('CommandExecutionError', () => {
    test('creates error with command', () => {
      const error = new CommandExecutionError('Exec failed', HardwareCommand.HELLO)
      expect(error.message).toBe('Exec failed')
      expect(error.name).toBe('CommandExecutionError')
      expect(error.code).toBe('COMMAND_EXECUTION_FAILED')
      expect(error.command).toBe(HardwareCommand.HELLO)
    })

    test('is instanceof HardwareError', () => {
      const error = new CommandExecutionError('Test', HardwareCommand.DEVICE_STATUS)
      expect(error instanceof HardwareError).toBe(true)
    })
  })

  describe('ParseError', () => {
    test('creates error with message', () => {
      const error = new ParseError('Parse failed')
      expect(error.message).toBe('Parse failed')
      expect(error.name).toBe('ParseError')
      expect(error.code).toBe('PARSE_ERROR')
      expect(error.rawData).toBeUndefined()
    })

    test('creates error with raw data', () => {
      const error = new ParseError('Parse failed', 'raw string')
      expect(error.rawData).toBe('raw string')
    })

    test('is instanceof HardwareError', () => {
      const error = new ParseError('Test')
      expect(error instanceof HardwareError).toBe(true)
    })
  })
})

describe('Zod Schema', () => {
  describe('rawDeviceDataSchema', () => {
    test('validates correct data', () => {
      const validData = {
        tgHeatLevelR: '50',
        tgHeatLevelL: '-30',
        heatTimeL: '1800',
        heatLevelL: '-25',
        heatTimeR: '3600',
        heatLevelR: '45',
        sensorLabel: '8SLEEP-SN-12345-I00',
        waterLevel: 'true' as const,
        priming: 'false' as const,
        doubleTap: '{"l":0,"r":1}',
        tripleTap: '{"l":2,"r":0}',
        quadTap: '{"l":0,"r":0}',
      }

      const result = rawDeviceDataSchema.safeParse(validData)
      expect(result.success).toBe(true)
    })

    test('rejects invalid temperature level format', () => {
      const invalidData = {
        tgHeatLevelR: 'abc', // Not a number
        tgHeatLevelL: '-30',
        heatTimeL: '1800',
        heatLevelL: '-25',
        heatTimeR: '3600',
        heatLevelR: '45',
        sensorLabel: '8SLEEP-SN-12345-I00',
        waterLevel: 'true' as const,
        priming: 'false' as const,
      }

      const result = rawDeviceDataSchema.safeParse(invalidData)
      expect(result.success).toBe(false)
    })

    test('rejects invalid duration format', () => {
      const invalidData = {
        tgHeatLevelR: '50',
        tgHeatLevelL: '-30',
        heatTimeL: '-100', // Negative duration not allowed
        heatLevelL: '-25',
        heatTimeR: '3600',
        heatLevelR: '45',
        sensorLabel: '8SLEEP-SN-12345-I00',
        waterLevel: 'true' as const,
        priming: 'false' as const,
      }

      const result = rawDeviceDataSchema.safeParse(invalidData)
      expect(result.success).toBe(false)
    })

    test('accepts optional gesture fields', () => {
      const minimalData = {
        tgHeatLevelR: '0',
        tgHeatLevelL: '0',
        heatTimeL: '0',
        heatLevelL: '0',
        heatTimeR: '0',
        heatLevelR: '0',
        sensorLabel: '8SLEEP-SN-12345-H00',
        waterLevel: 'true' as const,
        priming: 'false' as const,
      }

      const result = rawDeviceDataSchema.safeParse(minimalData)
      expect(result.success).toBe(true)
    })

    test('validates waterLevel enum', () => {
      const invalidWaterLevel = {
        tgHeatLevelR: '0',
        tgHeatLevelL: '0',
        heatTimeL: '0',
        heatLevelL: '0',
        heatTimeR: '0',
        heatLevelR: '0',
        sensorLabel: '8SLEEP',
        waterLevel: 'maybe', // Invalid enum value
        priming: 'false' as const,
      }

      const result = rawDeviceDataSchema.safeParse(invalidWaterLevel)
      expect(result.success).toBe(false)
    })

    test('prevents regex bypass with partial matches', () => {
      // Ensures anchors (^ and $) are present
      const partialMatch = {
        tgHeatLevelR: '50abc', // Should fail - not just digits
        tgHeatLevelL: '-30',
        heatTimeL: '1800',
        heatLevelL: '-25',
        heatTimeR: '3600',
        heatLevelR: '45',
        sensorLabel: '8SLEEP',
        waterLevel: 'true' as const,
        priming: 'false' as const,
      }

      const result = rawDeviceDataSchema.safeParse(partialMatch)
      expect(result.success).toBe(false)
    })
  })
})

describe('Type Definitions', () => {
  test('Side type accepts valid values', () => {
    const left: 'left' | 'right' = 'left'
    const right: 'left' | 'right' = 'right'
    expect(left).toBe('left')
    expect(right).toBe('right')
  })

  test('AlarmConfig has correct structure', () => {
    const config: AlarmConfig = {
      vibrationIntensity: 50,
      vibrationPattern: 'rise',
      duration: 60,
    }
    expect(config.vibrationIntensity).toBe(50)
    expect(config.vibrationPattern).toBe('rise')
    expect(config.duration).toBe(60)
  })
})
