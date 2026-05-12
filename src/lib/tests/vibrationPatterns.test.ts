import { describe, expect, test } from 'vitest'
import { FIXED_INTENSITY, FIXED_PATTERN, VIBRATION_PRESETS } from '../vibrationPatterns'

describe('VIBRATION_PRESETS', () => {
  test('exposes a non-empty preset list', () => {
    expect(VIBRATION_PRESETS.length).toBeGreaterThan(0)
  })

  test('every preset has the required shape and a sane duration', () => {
    for (const preset of VIBRATION_PRESETS) {
      expect(typeof preset.name).toBe('string')
      expect(preset.name.length).toBeGreaterThan(0)
      expect(typeof preset.description).toBe('string')
      expect(preset.duration).toBeGreaterThanOrEqual(10)
    }
  })

  test('preset names are unique — they double as React keys in selectors', () => {
    const names = VIBRATION_PRESETS.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

describe('Fixed cosmetic fields', () => {
  test('intensity is a valid uint in firmware range', () => {
    expect(FIXED_INTENSITY).toBeGreaterThanOrEqual(1)
    expect(FIXED_INTENSITY).toBeLessThanOrEqual(100)
  })

  test('pattern is a firmware-accepted string', () => {
    expect(['rise', 'double']).toContain(FIXED_PATTERN)
  })
})
