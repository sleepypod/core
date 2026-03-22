'use client'

import { trpc } from '@/src/utils/trpc'
import type { TempUnit } from '@/src/lib/tempUtils'

/**
 * Global temperature unit gate. Reads the user's preference from device
 * settings and provides formatting helpers. All components should use this
 * instead of hardcoding 'F' or doing their own conversion.
 *
 * Internal data is always Celsius (WS frames, DB centidegrees).
 * This hook converts at display time based on the stored preference.
 */
export function useTemperatureUnit() {
  const { data: settings } = trpc.settings.getAll.useQuery(
    {},
    { staleTime: 60_000, refetchInterval: 60_000 },
  )

  const unit: TempUnit = (settings?.device?.temperatureUnit as TempUnit) ?? 'F'

  /** Convert Celsius to the user's preferred unit. */
  function convert(celsius: number | null | undefined): number | null {
    if (celsius === null || celsius === undefined) return null
    return unit === 'F' ? celsius * 9 / 5 + 32 : celsius
  }

  /** Format a Celsius value to a display string in the user's preferred unit. */
  function formatTemp(celsius: number | null | undefined): string {
    const v = convert(celsius)
    if (v === null) return '--'
    return `${v.toFixed(1)}°${unit}`
  }

  /** Format a Celsius value as a short integer (no decimal). */
  function formatTempShort(celsius: number | null | undefined): string {
    const v = convert(celsius)
    if (v === null) return '--'
    return `${Math.round(v)}°`
  }

  /** Format an already-converted value (e.g., from tRPC with unit param). */
  function formatConverted(value: number | null | undefined): string {
    if (value === null || value === undefined) return '--'
    return `${value.toFixed(1)}°${unit}`
  }

  /** The unit suffix string. */
  const suffix = `°${unit}`

  return { unit, convert, formatTemp, formatTempShort, formatConverted, suffix }
}
