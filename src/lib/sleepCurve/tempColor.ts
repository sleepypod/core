/**
 * Temperature-to-color mapping — ported from iOS TempColor enum.
 * Maps temperature offsets from base (80°F) to visual colors.
 */

/** Get a color for a temperature offset (from 80°F base) */
export function colorForTempOffset(offset: number): string {
  if (offset <= -8) return '#2563eb' // deep blue
  if (offset <= -5) return '#4a90d9' // cold mid
  if (offset <= -2) return '#7ab5e0' // cold soft
  if (offset <= 1) return '#9ca3af'  // neutral gray
  if (offset <= 4) return '#e0976a'  // warm soft
  if (offset <= 7) return '#dc6646'  // warm mid
  return '#dc2626'                   // warm deep
}

/** Get a color for an absolute temperature in °F */
export function colorForTempF(tempF: number): string {
  return colorForTempOffset(tempF - 80)
}

/** Get CSS gradient stops for a temperature range */
export function tempGradientStops(minOffset: number, maxOffset: number): string {
  const steps = [
    { offset: -8, color: '#2563eb' },
    { offset: -5, color: '#4a90d9' },
    { offset: -2, color: '#7ab5e0' },
    { offset: 0, color: '#9ca3af' },
    { offset: 2, color: '#e0976a' },
    { offset: 5, color: '#dc6646' },
    { offset: 8, color: '#dc2626' },
  ]

  const range = maxOffset - minOffset || 1
  return steps
    .filter(s => s.offset >= minOffset - 2 && s.offset <= maxOffset + 2)
    .map(s => {
      const pct = ((s.offset - minOffset) / range) * 100
      return `${s.color} ${Math.max(0, Math.min(100, pct))}%`
    })
    .join(', ')
}
