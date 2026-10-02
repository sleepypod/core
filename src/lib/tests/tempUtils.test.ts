import { describe, expect, test } from 'vitest'
import {
  centiDegreesToC,
  centiDegreesToF,
  centidegreesToDisplay,
  centiPercentToPercent,
  determineTrend,
  displayToSetpointF,
  ensureF,
  formatDisplayTemp,
  formatSensorC,
  formatSetpointF,
  formatTemp,
  mapToEightSleepScale,
  sensorCToDisplay,
  setpointFToDisplay,
  toC,
  toF,
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

describe('formatTemp', () => {
  test('rounds to nearest integer and defaults to Fahrenheit', () => {
    expect(formatTemp(72.4)).toBe('72°F')
    expect(formatTemp(72.6)).toBe('73°F')
  })

  test('rounds .5 upward (Math.round semantics)', () => {
    expect(formatTemp(72.5)).toBe('73°F')
  })

  test('honours Celsius unit', () => {
    expect(formatTemp(22.3, 'C')).toBe('22°C')
  })

  test('handles negative values', () => {
    expect(formatTemp(-5.4, 'C')).toBe('-5°C')
  })
})

describe('temperature domain helpers', () => {
  test('converts canonical Fahrenheit setpoints to display units', () => {
    expect(setpointFToDisplay(68, 'F')).toBe(68)
    expect(setpointFToDisplay(68, 'C')).toBe(20)
    expect(setpointFToDisplay(null, 'C')).toBeNull()
  })

  test('converts display edits back to canonical Fahrenheit setpoints', () => {
    expect(displayToSetpointF(68, 'F')).toBe(68)
    expect(displayToSetpointF(20, 'C')).toBe(68)
    expect(displayToSetpointF(undefined, 'F')).toBeNull()
  })

  test('converts live Celsius sensors to display units', () => {
    expect(sensorCToDisplay(20, 'C')).toBe(20)
    expect(sensorCToDisplay(20, 'F')).toBe(68)
    expect(sensorCToDisplay(null, 'F')).toBeNull()
  })

  test('converts stored centidegrees Celsius to display units', () => {
    expect(centidegreesToDisplay(2000, 'C')).toBe(20)
    expect(centidegreesToDisplay(2000, 'F')).toBe(68)
    expect(centidegreesToDisplay(undefined, 'F')).toBeNull()
  })

  test('formats display values with configurable precision and null output', () => {
    expect(formatDisplayTemp(68.25, 'F')).toBe('68°F')
    expect(formatDisplayTemp(68.25, 'F', { decimals: 1 })).toBe('68.3°F')
    expect(formatDisplayTemp(68.25, 'F', { includeUnit: false })).toBe('68°')
    expect(formatDisplayTemp(null, 'F')).toBe('--')
    expect(formatDisplayTemp(undefined, 'C', { nullDisplay: '—' })).toBe('—')
    expect(formatDisplayTemp(-0.1, 'C', { decimals: 0 })).toBe('0°C')
  })

  test('formats setpoints and sensors from their source units', () => {
    expect(formatSetpointF(68, 'C')).toBe('20°C')
    expect(formatSetpointF(null, 'C')).toBe('--')
    expect(formatSensorC(20, 'F', { decimals: 1 })).toBe('68.0°F')
    expect(formatSensorC(undefined, 'F')).toBe('--')
  })

  test('round trips Celsius setpoint edits back to Fahrenheit', () => {
    const display = setpointFToDisplay(77, 'C')
    expect(display).toBe(25)
    expect(displayToSetpointF(display, 'C')).toBe(77)
  })
})

describe('determineTrend', () => {
  test('"up" when target is more than 0.5° above current', () => {
    expect(determineTrend(70, 71)).toBe('up')
  })

  test('"down" when target is more than 0.5° below current', () => {
    expect(determineTrend(72, 70)).toBe('down')
  })

  test('"stable" when |diff| <= 0.5°', () => {
    expect(determineTrend(70, 70)).toBe('stable')
    expect(determineTrend(70, 70.5)).toBe('stable')
    expect(determineTrend(70.5, 70)).toBe('stable')
  })

  test('thresholds are exclusive (exactly 0.5 is stable, not up/down)', () => {
    expect(determineTrend(70, 70.5)).toBe('stable')
    expect(determineTrend(70, 70.51)).toBe('up')
    expect(determineTrend(70.51, 70)).toBe('down')
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
