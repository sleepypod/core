import { TEMP_NEUTRAL, TEMP_RANGE } from '@/src/hardware/types'
import { TEMP } from '@/src/lib/tempColors'
import { setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'
import type { TempDisplay } from '@/src/providers/PrefsProvider'
import { stepTargetF } from './tempScreenUtils'

export * from '@/src/lib/nightPhases'

// ── Eight Sleep levels ──────────────────────────────────────────────────────
// The pod's own scale: hardware level −100…100 in tenths, so −10…+10 with
// 0 = 82.5°F and each step 2.75°F. Whole °F set points round-trip exactly
// (max rounding error 0.5°F < half a step).

const LEVEL_STEP_F = TEMP_RANGE / 10

export function levelForF(f: number): number {
  return Math.max(-10, Math.min(10, Math.round((f - TEMP_NEUTRAL) / LEVEL_STEP_F)))
}

export function fForLevel(level: number): number {
  return Math.round(TEMP_NEUTRAL + Math.max(-10, Math.min(10, level)) * LEVEL_STEP_F)
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0'
}

/** "+3" · "−2" · "0" on the Eight Sleep −10…+10 scale. */
export function formatLevel(f: number): string {
  return signed(levelForF(f))
}

/**
 * ± one step in whatever the big number reads in: an Eight Sleep level, or a
 * display degree (°F / °C, which offset mode also counts in). Whole °F out.
 */
export function stepForDisplay(f: number, delta: number, unit: TempUnit, display: TempDisplay): number {
  if (display === 'level') return fForLevel(levelForF(Math.round(f)) + delta)
  return stepTargetF(f, delta, unit)
}

/** Big-number text for a °F set point in the chosen display mode. */
export function formatForDisplay(f: number, unit: TempUnit, display: TempDisplay): string {
  if (display === 'level') return formatLevel(f)
  if (display === 'offset') return signed(Math.round(f) - TEMP.BASE_F)
  return `${Math.round(setpointFToDisplay(f, unit) ?? f)}°${unit}`
}
