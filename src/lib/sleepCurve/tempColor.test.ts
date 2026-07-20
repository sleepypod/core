import { describe, expect, test } from 'vitest'
import { colorForTempF, colorForTempOffset, tempGradientStops } from './tempColor'

describe('colorForTempOffset', () => {
  // Inclusive upper-bound bands ported from iOS TempColor
  test.each([
    [-100, '#2563eb'],
    [-8, '#2563eb'],
    [-7.99, '#4a90d9'],
    [-5, '#4a90d9'],
    [-4.99, '#7ab5e0'],
    [-2, '#7ab5e0'],
    [-1.99, '#9ca3af'],
    [0, '#9ca3af'],
    [1, '#9ca3af'],
    [1.01, '#e0976a'],
    [4, '#e0976a'],
    [4.01, '#dc6646'],
    [7, '#dc6646'],
    [7.01, '#dc2626'],
    [100, '#dc2626'],
  ])('offset=%s → %s', (offset, expected) => {
    expect(colorForTempOffset(offset)).toBe(expected)
  })
})

describe('colorForTempF', () => {
  test('delegates to colorForTempOffset using 80°F as base', () => {
    expect(colorForTempF(80)).toBe(colorForTempOffset(0))
    expect(colorForTempF(72)).toBe(colorForTempOffset(-8))
    expect(colorForTempF(85)).toBe(colorForTempOffset(5))
    expect(colorForTempF(90)).toBe(colorForTempOffset(10))
  })
})

describe('tempGradientStops', () => {
  test('returns the colour stops within the (range ± 2) window', () => {
    const stops = tempGradientStops(-2, 2).split(', ').map(s => s.split(' '))
    // Predefined stops sit at -8, -5, -2, 0, 2, 5, 8. With ±2 buffer the
    // [-4, 4] window admits the -2/0/+2 stops.
    const colours = stops.map(s => s[0])
    expect(colours).toEqual(['#7ab5e0', '#9ca3af', '#e0976a'])
    expect(tempGradientStops(-2, 2)).toBe('#7ab5e0 0%, #9ca3af 50%, #e0976a 100%')
  })

  test('emits percentages clamped to [0, 100]', () => {
    const stops = tempGradientStops(-2, 2).split(', ').map(s => s.split(' '))
    for (const [, pctText] of stops) {
      const pct = Number.parseFloat(pctText)
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
  })

  test('handles a zero-width range without dividing by zero', () => {
    const result = tempGradientStops(0, 0)
    // Should still return a string, with all stops clamped to 0 or 100
    expect(typeof result).toBe('string')
    const stops = result.split(', ').map(s => s.split(' '))
    for (const [, pctText] of stops) {
      const pct = Number.parseFloat(pctText)
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
    expect(result).toBe('#7ab5e0 0%, #9ca3af 0%, #e0976a 100%')
  })

  test('uses both inclusive two-degree filter buffers and exact range arithmetic', () => {
    expect(tempGradientStops(0, 4)).toBe(
      '#7ab5e0 0%, #9ca3af 0%, #e0976a 50%, #dc6646 100%',
    )
  })

  test('renders the cool end of the spectrum for a fully cold range', () => {
    const result = tempGradientStops(-10, -5)
    expect(result).toContain('#2563eb')
    expect(result).toContain('#4a90d9')
    // Warm-end colours should be excluded
    expect(result).not.toContain('#dc2626')
  })
})
