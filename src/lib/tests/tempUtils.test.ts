import { describe, expect, test } from 'vitest'
import {
  centiDegreesToC,
  centiDegreesToF,
  centiPercentToPercent,
  toF,
  toC,
  ensureF,
  mapToEightSleepScale,
} from '../tempUtils'

describe('centiDegreesToC', () => {
  test('converts centidegrees to Celsius', () => {
    expect(centiDegreesToC(2500)).toBe(25)
    expect(centiDegreesToC(0)).toBe(0)
    expect(centiDegreesToC(10000)).toBe(100)
  })

  test('preserves fractional precision', () => {
    expect(centiDegreesToC(2550)).toBe(25.5)
    expect(centiDegreesToC(2001)).toBe(20.01)
  })

  test('handles negative values', () => {
    expect(centiDegreesToC(-1000)).toBe(-10)
  })
})

describe('centiDegreesToF', () => {
  test('converts centidegrees to Fahrenheit', () => {
    // 0°C = 32°F
    expect(centiDegreesToF(0)).toBe(32)
    // 100°C = 212°F
    expect(centiDegreesToF(10000)).toBe(212)
  })

  test('converts room temperature', () => {
    // 25°C = 77°F
    expect(centiDegreesToF(2500)).toBe(77)
  })
})

describe('centiPercentToPercent', () => {
  test('converts centipercent to percent', () => {
    expect(centiPercentToPercent(5000)).toBe(50)
    expect(centiPercentToPercent(0)).toBe(0)
    expect(centiPercentToPercent(10000)).toBe(100)
  })

  test('preserves fractional precision', () => {
    expect(centiPercentToPercent(6523)).toBe(65.23)
  })
})

describe('toF / toC', () => {
  test('toF converts Celsius to Fahrenheit', () => {
    expect(toF(0)).toBe(32)
    expect(toF(100)).toBe(212)
    expect(toF(-40)).toBe(-40) // intersection point
  })

  test('toC converts Fahrenheit to Celsius', () => {
    expect(toC(32)).toBe(0)
    expect(toC(212)).toBe(100)
    expect(toC(-40)).toBe(-40)
  })

  test('roundtrip conversion', () => {
    expect(toC(toF(25))).toBeCloseTo(25, 10)
    expect(toF(toC(77))).toBeCloseTo(77, 10)
  })
})

describe('ensureF', () => {
  test('passes through Fahrenheit values', () => {
    expect(ensureF(72, 'F')).toBe(72)
  })

  test('converts Celsius to Fahrenheit', () => {
    expect(ensureF(0, 'C')).toBe(32)
  })

  test('defaults to Fahrenheit', () => {
    expect(ensureF(72)).toBe(72)
  })
})

describe('mapToEightSleepScale', () => {
  test('maps min temp to scale 1', () => {
    expect(mapToEightSleepScale(55)).toBe(1)
  })

  test('maps max temp to scale 10', () => {
    expect(mapToEightSleepScale(95)).toBe(10)
  })

  test('clamps below minimum', () => {
    expect(mapToEightSleepScale(40)).toBe(1)
  })

  test('clamps above maximum', () => {
    expect(mapToEightSleepScale(120)).toBe(10)
  })

  test('maps midpoint correctly', () => {
    expect(mapToEightSleepScale(75)).toBe(6) // (75-55)/(95-55) = 0.5 → 5.5 → 6
  })
})
