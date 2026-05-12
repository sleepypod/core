/**
 * Shared vibration presets — duration-only.
 *
 * On Pod 5 J55 firmware the cover MCU clamps `pl` (intensity) and `pi`
 * (pattern) — both are cosmetic. Only `du` (duration) has a user-perceptible
 * effect. The API still accepts intensity/pattern for forward compatibility,
 * but the UI no longer exposes them.
 *
 * See docs/hardware/alarms.md#empirical-behavior-pl-and-pi.
 */

export interface VibrationPreset {
  name: string
  duration: number // seconds
  description: string
}

export const VIBRATION_PRESETS: VibrationPreset[] = [
  { name: 'Quick', duration: 10, description: 'Brief buzz' },
  { name: 'Standard', duration: 30, description: 'Default alarm' },
  { name: 'Long', duration: 60, description: 'Extended ramp' },
]

/**
 * Hardcoded values sent for the cosmetic fields. Kept in one place so the API
 * surface stays unchanged.
 */
export const FIXED_INTENSITY = 100
export const FIXED_PATTERN = 'rise' as const
