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
export function glowColorForDelta(delta: number): { color: string; opacity: number } {
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
