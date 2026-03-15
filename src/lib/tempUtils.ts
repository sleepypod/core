export type TempUnit = 'F' | 'C'

export const toF = (c: number) => (c * 9) / 5 + 32
export const toC = (f: number) => ((f - 32) * 5) / 9

export const formatTemp = (value: number, unit: TempUnit = 'F') => {
  const rounded = Math.round(value)
  return `${rounded}°${unit}`
}

export const determineTrend = (current: number, target: number) => {
  const diff = target - current
  if (diff > 0.5) return 'up'
  if (diff < -0.5) return 'down'
  return 'stable'
}

/**
 * Map a temperature to an Eight Sleep scale (1-10).
 * Input expected in Fahrenheit. If input is outside range, it will be clamped.
 */
export const mapToEightSleepScale = (tempF: number) => {
  const inMin = 55
  const inMax = 95
  const outMin = 1
  const outMax = 10
  const v = Math.max(inMin, Math.min(inMax, tempF))
  const ratio = (v - inMin) / (inMax - inMin)
  return Math.round(outMin + ratio * (outMax - outMin))
}

export const ensureF = (temp: number, unit: TempUnit = 'F') =>
  unit === 'C' ? toF(temp) : temp

/** Convert raw centidegrees (u16 from hardware) to degrees Celsius. */
export const centiDegreesToC = (cd: number) => cd / 100

/** Convert raw centidegrees (u16 from hardware) to degrees Fahrenheit. */
export const centiDegreesToF = (cd: number) => toF(cd / 100)

/** Convert raw centipercent (u16 from hardware) to percent. */
export const centiPercentToPercent = (cp: number) => cp / 100
