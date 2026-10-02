import { TEMP_NEUTRAL } from '@/src/hardware/types'

/**
 * Temperature color utilities matching iOS TempColor enum.
 * Colors are based on the delta between target and current temperature.
 */

// Deep blue → soft blue → neutral → soft orange → deep red
const COLD_DEEP = '#2563eb'
const COLD_MID = '#4a90d9'
const COLD_SOFT = '#7ab5e0'
const NEUTRAL = '#9ca3af'
const WARM_SOFT = '#e0976a'
const WARM_MID = '#dc6646'
const WARM_DEEP = '#dc2626'

// Theme constants matching iOS Theme enum
export const theme = {
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
} as const

/** Color for a given temperature delta (target - current). */
export function colorForDelta(delta: number): string {
  if (delta <= -8) return COLD_DEEP
  if (delta <= -5) return COLD_MID
  if (delta <= -2) return COLD_SOFT
  if (delta <= 1) return NEUTRAL
  if (delta <= 4) return WARM_SOFT
  if (delta <= 7) return WARM_MID
  return WARM_DEEP
}

/** Glow color with intensity based on delta magnitude. */
export function glowColorForDelta(delta: number): { color: string, opacity: number } {
  const intensity = Math.min(Math.abs(delta) / 8, 1) * 0.8
  return {
    color: colorForDelta(delta),
    opacity: Math.max(intensity, 0.3),
  }
}

/** Temperature constants matching iOS TemperatureConversion. */
export const TEMP = {
  BASE_F: 80,
  MIN_F: 55,
  MAX_F: 110,
  MIN_OFFSET: -20,
  MAX_OFFSET: 20,
} as const

/** Convert absolute temp to offset from 80°F base. */
export function tempFToOffset(tempF: number): number {
  return tempF - TEMP.BASE_F
}

/** Format offset with +/- sign. */
export function offsetDisplay(offset: number): string {
  if (offset > 0) return `+${offset}`
  if (offset < 0) return `${offset}`
  return '0'
}

/**
 * Hue for a set point: blue when cool, violet around neutral (82.5°F), rose
 * when warm — saturating 8°F either side, as in the Eight Sleep app.
 */
export function tempHue(f: number): number {
  const t = Math.max(-1, Math.min(1, (f - TEMP_NEUTRAL) / 8))
  return Math.round(t < 0 ? 268 + t * 45 : 268 + t * 77)
}

/**
 * Sky hue for a time of day (minutes past midnight) — the card's upper wash:
 * deep indigo at night, rose-amber at dawn, pale sky by day, violet at dusk.
 */
export function skyHue(minutes: number): number {
  const m = ((minutes % 1440) + 1440) % 1440
  const stops: [number, number][] = [
    [0, 235], [300, 240], [390, 15], [480, 205], [1020, 205], [1140, 290], [1290, 235], [1440, 235],
  ]
  for (let i = 0; i < stops.length - 1; i++) {
    const [m0, h0] = stops[i]
    const [m1, h1] = stops[i + 1]
    if (m >= m0 && m <= m1) {
      // Interpolate the short way round the hue wheel.
      let d = h1 - h0
      if (d > 180) d -= 360
      if (d < -180) d += 360
      return Math.round((h0 + d * ((m - m0) / (m1 - m0)) + 360) % 360)
    }
  }
  return 235
}
