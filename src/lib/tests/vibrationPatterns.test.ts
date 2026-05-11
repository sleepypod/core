import { describe, expect, test } from 'vitest'
import { VIBRATION_PRESETS } from '../vibrationPatterns'

describe('VIBRATION_PRESETS', () => {
  test('exposes a non-empty preset list', () => {
    expect(VIBRATION_PRESETS.length).toBeGreaterThan(0)
  })

  test('every preset has the required shape and uses a known pattern', () => {
    for (const preset of VIBRATION_PRESETS) {
      expect(typeof preset.name).toBe('string')
      expect(preset.name.length).toBeGreaterThan(0)
      expect(typeof preset.description).toBe('string')
      expect(['rise', 'double']).toContain(preset.pattern)
      expect(Number.isFinite(preset.intensity)).toBe(true)
      expect(preset.intensity).toBeGreaterThanOrEqual(1)
      expect(preset.intensity).toBeLessThanOrEqual(100)
      expect(preset.duration).toBeGreaterThan(0)
    }
  })

  test('preset names are unique — they double as React keys in selectors', () => {
    const names = VIBRATION_PRESETS.map(p => p.name)
    expect(new Set(names).size).toBe(names.length)
  })
})
