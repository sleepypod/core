import { describe, expect, test, vi } from 'vitest'
import { PodVersion } from '../types'
import { decodeSettings, parseDeviceStatus, parseSimpleResponse } from '../responseParser'
import {
  CBOR_SETTINGS_HEX,
  CBOR_SETTINGS_PARSED,
  DEVICE_STATUS_POD3,
  DEVICE_STATUS_POD4,
  DEVICE_STATUS_POD5,
} from './fixtures'

describe('parseDeviceStatus', () => {
  test('parses Pod 4 status with gestures', () => {
    const status = parseDeviceStatus(DEVICE_STATUS_POD4)

    expect(status.podVersion).toBe(PodVersion.POD_4)
    expect(status.sensorLabel).toBe('8SLEEP-SN-12345-I00')
    expect(status.waterLevel).toBe('ok')
    expect(status.isPriming).toBe(false)

    // Check left side
    expect(status.leftSide.currentLevel).toBe(-25)
    expect(status.leftSide.targetLevel).toBe(-30)
    expect(status.leftSide.heatingDuration).toBe(1800)
    expect(status.leftSide.currentTemperature).toBe(76) // Level -25 = ~76°F
    expect(status.leftSide.targetTemperature).toBe(74) // Level -30 = ~74°F

    // Check right side
    expect(status.rightSide.currentLevel).toBe(45)
    expect(status.rightSide.targetLevel).toBe(50)
    expect(status.rightSide.heatingDuration).toBe(3600)
    expect(status.rightSide.currentTemperature).toBe(95) // Level 45 = ~95°F
    expect(status.rightSide.targetTemperature).toBe(96) // Level 50 = ~96°F

    // Check gestures
    expect(status.gestures).toBeDefined()
    expect(status.gestures?.doubleTap).toEqual({ l: 0, r: 1 })
    expect(status.gestures?.tripleTap).toEqual({ l: 2, r: 0 })
    expect(status.gestures?.quadTap).toEqual({ l: 0, r: 0 })
  })

  test('parses Pod 3 status without gestures', () => {
    const status = parseDeviceStatus(DEVICE_STATUS_POD3)

    expect(status.podVersion).toBe(PodVersion.POD_3)
    expect(status.sensorLabel).toBe('8SLEEP-SN-98765-H00')
    expect(status.waterLevel).toBe('ok')
    expect(status.isPriming).toBe(false)

    // All values at neutral. Level 0 is off, not a real setpoint — it must
    // surface as null, not the phantom 82.5°F→83°F readback.
    expect(status.leftSide.currentLevel).toBe(0)
    expect(status.leftSide.targetLevel).toBe(0)
    expect(status.leftSide.currentTemperature).toBeNull()
    expect(status.leftSide.targetTemperature).toBeNull()
    expect(status.rightSide.currentLevel).toBe(0)
    expect(status.rightSide.targetLevel).toBe(0)
    expect(status.rightSide.currentTemperature).toBeNull()
    expect(status.rightSide.targetTemperature).toBeNull()

    // No gestures for Pod 3
    expect(status.gestures).toBeUndefined()
  })

  test('parses Pod 5 status', () => {
    const status = parseDeviceStatus(DEVICE_STATUS_POD5)

    expect(status.podVersion).toBe(PodVersion.POD_5)
    expect(status.sensorLabel).toBe('8SLEEP-SN-54321-J00')
    expect(status.waterLevel).toBe('low')
    expect(status.isPriming).toBe(true)

    // Check extreme temperature values
    expect(status.leftSide.currentLevel).toBe(-95)
    expect(status.leftSide.targetLevel).toBe(-100)
    expect(status.leftSide.currentTemperature).toBe(56) // Level -95 = ~56°F
    expect(status.leftSide.targetTemperature).toBe(55) // Level -100 = 55°F (min)

    expect(status.rightSide.currentLevel).toBe(98)
    expect(status.rightSide.targetLevel).toBe(100)
    expect(status.rightSide.currentTemperature).toBe(109) // Level 98 = 109°F
    expect(status.rightSide.targetTemperature).toBe(110) // Level 100 = 110°F (max)
  })

  test('handles malformed response', () => {
    const malformed = 'invalid data without proper format'

    expect(() => parseDeviceStatus(malformed)).toThrow('Failed to parse device status')
  })

  test('handles response with missing fields', () => {
    const incomplete = `tgHeatLevelR = 0
heatTimeL = 0

`

    expect(() => parseDeviceStatus(incomplete)).toThrow('Failed to parse device status')
  })

  test('handles values containing equals sign', () => {
    const withEquals = `tgHeatLevelR = 0
tgHeatLevelL = 0
heatTimeL = 0
heatLevelL = 0
heatTimeR = 0
heatLevelR = 0
sensorLabel = FOO=BAR=BAZ
waterLevel = true
priming = false

`

    const status = parseDeviceStatus(withEquals)
    expect(status.sensorLabel).toBe('FOO=BAR=BAZ')
  })

  test('trims keys and values independently on every wire line', () => {
    const padded = [
      '  tgHeatLevelR = 0  ',
      '  tgHeatLevelL = 0  ',
      '  heatTimeL = 0  ',
      '  heatLevelL = 0  ',
      '  heatTimeR = 0  ',
      '  heatLevelR = 0  ',
      '  sensorLabel = J55  ',
      '  waterLevel = true  ',
      '  priming = false  ',
      '',
      '',
    ].join('\n')

    const status = parseDeviceStatus(padded)
    expect(status).toEqual(expect.objectContaining({
      podVersion: PodVersion.POD_5,
      sensorLabel: 'J55',
      waterLevel: 'ok',
      isPriming: false,
    }))
  })

  test('strips surrounding quotes from sensorLabel', () => {
    const withQuotes = `tgHeatLevelR = 0
tgHeatLevelL = 0
heatTimeL = 0
heatLevelL = 0
heatTimeR = 0
heatLevelR = 0
sensorLabel = "20600-0003-J55-B0708DE3"
waterLevel = true
priming = false

`

    const status = parseDeviceStatus(withQuotes)
    expect(status.sensorLabel).toBe('20600-0003-J55-B0708DE3')
    // Real Pod 5 labels put the rev code (`J55`) in segment 3 and a serial
    // (`B0708DE3`) in segment 4 — must classify as Pod 5, not Pod 3.
    expect(status.podVersion).toBe(PodVersion.POD_5)
  })

  test.each([
    ['"20600-0003-J55-B0708DE3', '20600-0003-J55-B0708DE3'],
    ['20600-0003-J55-B0708DE3"', '20600-0003-J55-B0708DE3'],
    ['20600-00"03-J55-B0708DE3', '20600-00"03-J55-B0708DE3'],
  ])('only strips a quote at either edge of sensorLabel', (wireLabel, expected) => {
    const status = parseDeviceStatus(`tgHeatLevelR = 0
tgHeatLevelL = 0
heatTimeL = 0
heatLevelL = 0
heatTimeR = 0
heatLevelR = 0
sensorLabel = ${wireLabel}
waterLevel = true
priming = false

`)

    expect(status.sensorLabel).toBe(expected)
    expect(status.podVersion).toBe(PodVersion.POD_5)
  })

  test.each([
    ['J55', PodVersion.POD_5],
    ['I00', PodVersion.POD_4],
    ['H00', PodVersion.POD_3],
    ['prefix-J55x', PodVersion.POD_3],
    ['prefix-xJ55', PodVersion.POD_3],
    ['prefix-J5', PodVersion.POD_3],
    ['prefix-J555', PodVersion.POD_3],
    ['prefix-j55', PodVersion.POD_3],
    ['prefix-Jxx', PodVersion.POD_3],
    ['JxJ55', PodVersion.POD_3],
  ])('classifies exact revision segment %s', (sensorLabel, expected) => {
    const status = parseDeviceStatus(`tgHeatLevelR = 0
tgHeatLevelL = 0
heatTimeL = 0
heatLevelL = 0
heatTimeR = 0
heatLevelR = 0
sensorLabel = ${sensorLabel}
waterLevel = true
priming = false

`)

    expect(status.podVersion).toBe(expected)
  })

  test('handles invalid gesture JSON', () => {
    const invalidGesture = `tgHeatLevelR = 0
tgHeatLevelL = 0
heatTimeL = 0
heatLevelL = 0
heatTimeR = 0
heatLevelR = 0
sensorLabel = 8SLEEP-SN-12345-I00
waterLevel = true
priming = false
doubleTap = {invalid json}

`

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const status = parseDeviceStatus(invalidGesture)
    // Should parse successfully but gestures should be undefined
    expect(status.gestures).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('Failed to parse gesture data:', expect.any(SyntaxError))
    warn.mockRestore()
  })
})

describe('parseSimpleResponse', () => {
  test('parses OK response', () => {
    const result = parseSimpleResponse('OK')
    expect(result.success).toBe(true)
    expect(result.message).toBe('OK')
  })

  test('parses empty response as success', () => {
    const result = parseSimpleResponse('')
    expect(result.success).toBe(true)
    expect(result.message).toBe('OK')
  })

  test('parses error response', () => {
    const result = parseSimpleResponse('ERROR: Invalid command')
    expect(result.success).toBe(false)
    expect(result.message).toBe('ERROR: Invalid command')
  })

  test('parses failure response', () => {
    const result = parseSimpleResponse('Failed to execute')
    expect(result.success).toBe(false)
    expect(result.message).toBe('Failed to execute')
  })

  test('handles whitespace', () => {
    const result = parseSimpleResponse('  OK  \n')
    expect(result.success).toBe(true)
    expect(result.message).toBe('OK')
  })

  test('treats unknown responses as success', () => {
    const result = parseSimpleResponse('READY')
    expect(result.success).toBe(true)
    expect(result.message).toBe('READY')
  })
})

describe('decodeSettings', () => {
  test('decodes valid CBOR hex string', () => {
    const decoded = decodeSettings(CBOR_SETTINGS_HEX)
    expect(decoded).toEqual(CBOR_SETTINGS_PARSED)
  })

  test('throws on invalid hex string', () => {
    expect(() => decodeSettings('invalid')).toThrow('Failed to decode CBOR settings')
  })

  test('throws on malformed CBOR data', () => {
    // Valid hex but not valid CBOR
    expect(() => decodeSettings('DEADBEEF')).toThrow('Failed to decode CBOR settings')
  })
})
