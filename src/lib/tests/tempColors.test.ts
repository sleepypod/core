import { describe, expect, test } from 'vitest'
import { colorForDelta, glowColorForDelta, offsetDisplay, TEMP, tempFToOffset, theme } from '../tempColors'

describe('colorForDelta', () => {
  // Banding boundaries — verify each step uses an inclusive upper bound.
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
  ])('delta=%s → %s', (delta, expected) => {
    expect(colorForDelta(delta)).toBe(expected)
  })
})

describe('glowColorForDelta', () => {
  test('delta of 0 picks the neutral colour and the floor opacity', () => {
    expect(glowColorForDelta(0)).toEqual({ color: '#9ca3af', opacity: 0.3 })
  })

  test('opacity scales with magnitude up to its 0.8 ceiling', () => {
    const small = glowColorForDelta(2)
    expect(small.color).toBe('#e0976a')
    // |2|/8 * 0.8 = 0.2, but floor is 0.3
    expect(small.opacity).toBe(0.3)

    const mid = glowColorForDelta(4)
    // |4|/8 * 0.8 = 0.4
    expect(mid.color).toBe('#e0976a')
    expect(mid.opacity).toBeCloseTo(0.4, 5)

    const max = glowColorForDelta(8)
    expect(max.color).toBe('#dc2626')
    expect(max.opacity).toBeCloseTo(0.8, 5)
  })

  test('caps opacity at 0.8 even when delta exceeds 8', () => {
    expect(glowColorForDelta(20).opacity).toBeCloseTo(0.8, 5)
    expect(glowColorForDelta(-20).opacity).toBeCloseTo(0.8, 5)
  })

  test('uses absolute value of delta when picking opacity', () => {
    const negative = glowColorForDelta(-4)
    expect(negative.opacity).toBeCloseTo(0.4, 5)
    expect(negative.color).toBe('#7ab5e0')
  })
})

describe('tempFToOffset', () => {
  test('subtracts the 80°F base', () => {
    expect(tempFToOffset(80)).toBe(0)
    expect(tempFToOffset(95)).toBe(15)
    expect(tempFToOffset(60)).toBe(-20)
  })
})

describe('offsetDisplay', () => {
  test.each([
    [5, '+5'],
    [12, '+12'],
    [0, '0'],
    [-3, '-3'],
    [-15, '-15'],
  ])('offset=%s → %s', (offset, expected) => {
    expect(offsetDisplay(offset)).toBe(expected)
  })
})

describe('TEMP constants', () => {
  test('expose the iOS conversion contract', () => {
    expect(TEMP.BASE_F).toBe(80)
    expect(TEMP.MIN_F).toBe(55)
    expect(TEMP.MAX_F).toBe(110)
    expect(TEMP.MIN_OFFSET).toBe(-20)
    expect(TEMP.MAX_OFFSET).toBe(20)
  })
})

describe('theme palette', () => {
  test('contains the documented colour tokens', () => {
    expect(theme).toEqual({
      background: '#0a0a0a',
      card: '#141414',
      cardBorder: '#333333',
      cardElevated: '#1a1a1a',
      warming: '#dc6646',
      cooling: '#4a90d9',
      accent: '#5cb8e0',
      healthy: '#50c878',
      error: '#e05050',
      amber: '#d4a84a',
      purple: '#a080d0',
      cyan: '#4ecdc4',
      textSecondary: '#888888',
      textTertiary: '#666666',
      textMuted: '#555555',
    })
  })
})
