import type { FrzWaterFrame } from '@/src/hooks/useSensorStream'

/** Bars on the tank gauge; `capLevel` runs 0–5. */
export const TANK_BARS = 5

export interface WaterTank {
  /** Lit bars, or null when the capacitive reading isn't valid (no gauge level). */
  level: number | null
  /** "4/5" when the level is valid, otherwise OK / Low from `hasWater`. */
  label: string
  tone: 'ok' | 'warn'
  /** Priming now, firmware asking for a prime, or neither. */
  prime: 'priming' | 'needed' | null
}

/**
 * Tank state from the thermal controller's `frzWater` frame (newer firmware).
 * Undefined without a frame so callers keep the binary DAC water level.
 * `capLevel` is used only when `capValid`.
 */
export function waterTank(frame: FrzWaterFrame | undefined): WaterTank | undefined {
  if (!frame) return undefined
  const level = frame.capValid ? Math.min(TANK_BARS, Math.max(0, Math.round(frame.capLevel))) : null
  const low = !frame.hasWater || (level != null && level <= 1)
  return {
    level,
    label: level != null ? `${level}/${TANK_BARS}` : frame.hasWater ? 'OK' : 'Low',
    tone: low ? 'warn' : 'ok',
    prime: frame.isPriming ? 'priming' : frame.needsPriming ? 'needed' : null,
  }
}
