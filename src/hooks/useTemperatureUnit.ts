'use client'

import { trpc } from '@/src/utils/trpc'
import {
  formatDisplayTemp,
  formatSensorC,
  sensorCToDisplay,
  type TempUnit,
} from '@/src/lib/tempUtils'

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
    return sensorCToDisplay(celsius, unit)
  }

  /** Format a Celsius value to a display string in the user's preferred unit. */
  function formatTemp(celsius: number | null | undefined): string {
    return formatSensorC(celsius, unit, { decimals: 1 })
  }

  /** Format a Celsius value as a short integer (no decimal). */
  function formatTempShort(celsius: number | null | undefined): string {
    return formatSensorC(celsius, unit, { includeUnit: false })
  }

  /** Format an already-converted value (e.g., from tRPC with unit param). */
  function formatConverted(value: number | null | undefined): string {
    return formatDisplayTemp(value, unit, { decimals: 1 })
  }

  /** The unit suffix string. */
  const suffix = `°${unit}`

  return { unit, convert, formatTemp, formatTempShort, formatConverted, suffix }
}
