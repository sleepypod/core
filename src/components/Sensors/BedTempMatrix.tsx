'use client'

import { useMemo } from 'react'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { BedTempFrame, BedTemp2Frame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'

/**
 * Map a temperature (Celsius) to a color string.
 * Blue (18C) → Green (28C) → Orange (38C).
 */
function tempToColor(tempC: number | undefined): string {
  if (tempC === undefined || tempC === null) return 'bg-zinc-800 text-zinc-500'
  const clamped = Math.max(18, Math.min(38, tempC))
  const ratio = (clamped - 18) / 20 // 0 = cold, 1 = hot

  if (ratio < 0.5) {
    // Blue → Green
    return ratio < 0.25
      ? 'bg-blue-900/60 text-blue-300'
      : 'bg-teal-900/60 text-teal-300'
  }
  // Green → Orange
  return ratio < 0.75
    ? 'bg-amber-900/40 text-amber-300'
    : 'bg-orange-900/50 text-orange-300'
}

/** Color from Fahrenheit value (for tRPC data which is already converted). */
function tempToColorF(tempF: number | null | undefined): string {
  if (tempF === undefined || tempF === null) return 'bg-zinc-800 text-zinc-500'
  // Convert back to C for the color mapping
  const tempC = (tempF - 32) * 5 / 9
  return tempToColor(tempC)
}

function formatTemp(value: unknown): string {
  if (value === undefined || value === null || typeof value !== 'number') return '--'
  // Convert to Fahrenheit for display
  const f = (value * 9) / 5 + 32
  return `${f.toFixed(1)}°`
}

function formatTempF(value: number | null | undefined): string {
  if (value === undefined || value === null) return '--'
  return `${value.toFixed(1)}°`
}

function formatTempC(value: unknown): string {
  if (value === undefined || value === null || typeof value !== 'number') return '--'
  return `${value.toFixed(1)}°C`
}

interface TempCellProps {
  label: string
  value: unknown
  zone: string
}

function TempCell({ label, value, zone }: TempCellProps) {
  const tempC = typeof value === 'number' ? value : undefined
  const colorClass = tempToColor(tempC)

  return (
    <div className={`flex flex-col items-center justify-center rounded-lg p-1.5 sm:p-2 ${colorClass}`}>
      <span className="text-[8px] font-medium uppercase tracking-wider opacity-70 sm:text-[9px]">
        {zone}
      </span>
      <span className="text-[13px] font-bold tabular-nums sm:text-sm">
        {formatTemp(value)}
      </span>
      <span className="text-[8px] opacity-50 sm:text-[9px]">{label}</span>
    </div>
  )
}

/** Pre-formatted temp cell that accepts already-computed display and color values. */
function TempCellFormatted({ display, colorClass, label, zone }: {
  display: string
  colorClass: string
  label: string
  zone: string
}) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-lg p-1.5 sm:p-2 ${colorClass}`}>
      <span className="text-[8px] font-medium uppercase tracking-wider opacity-70 sm:text-[9px]">
        {zone}
      </span>
      <span className="text-[13px] font-bold tabular-nums sm:text-sm">
        {display}
      </span>
      <span className="text-[8px] opacity-50 sm:text-[9px]">{label}</span>
    </div>
  )
}

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '--'
  const date = new Date(ts * 1000)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Bed temperature matrix display.
 * Shows a 3x2 grid of temperature readings matching the iOS BedMatrixView:
 * - Outer, Center, Inner zones for Left and Right sides.
 * Plus ambient temperature and humidity.
 *
 * Combines live WebSocket frames with tRPC fallback from
 * environment.getLatestBedTemp for initial data before WS connects.
 */
export function BedTempMatrix() {
  const bedTemp = useSensorFrame('bedTemp')
  const bedTemp2 = useSensorFrame('bedTemp2')

  // Prefer bedTemp2 (newer pods)
  const liveFrame: BedTempFrame | BedTemp2Frame | undefined = bedTemp2 ?? bedTemp

  // tRPC fallback: latest bed temp from database
  const latestBedTemp = trpc.environment.getLatestBedTemp.useQuery(
    { unit: 'F' },
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
      // Only used as fallback; stop refetching once live data is flowing
      enabled: !liveFrame,
    },
  )

  // Build a unified data source: live WS frame takes priority, tRPC as fallback
  const data = useMemo(() => {
    if (liveFrame) {
      return {
        source: 'live' as const,
        timestamp: liveFrame.ts,
        ambientTemp: formatTemp(liveFrame.ambientTemp),
        mcuTemp: formatTemp(liveFrame.mcuTemp),
        humidity: typeof liveFrame.humidity === 'number' ? `${liveFrame.humidity.toFixed(0)}%` : undefined,
        // For live data, TempCell uses raw Celsius values for color mapping
        leftOuter: { value: liveFrame.leftOuterTemp, display: formatTemp(liveFrame.leftOuterTemp), colorClass: tempToColor(liveFrame.leftOuterTemp) },
        leftCenter: { value: liveFrame.leftCenterTemp, display: formatTemp(liveFrame.leftCenterTemp), colorClass: tempToColor(liveFrame.leftCenterTemp) },
        leftInner: { value: liveFrame.leftInnerTemp, display: formatTemp(liveFrame.leftInnerTemp), colorClass: tempToColor(liveFrame.leftInnerTemp) },
        rightOuter: { value: liveFrame.rightOuterTemp, display: formatTemp(liveFrame.rightOuterTemp), colorClass: tempToColor(liveFrame.rightOuterTemp) },
        rightCenter: { value: liveFrame.rightCenterTemp, display: formatTemp(liveFrame.rightCenterTemp), colorClass: tempToColor(liveFrame.rightCenterTemp) },
        rightInner: { value: liveFrame.rightInnerTemp, display: formatTemp(liveFrame.rightInnerTemp), colorClass: tempToColor(liveFrame.rightInnerTemp) },
      }
    }

    const stored = latestBedTemp.data
    if (!stored) return null

    return {
      source: 'stored' as const,
      timestamp: stored.timestamp ? Math.floor(new Date(stored.timestamp as string).getTime() / 1000) : undefined,
      ambientTemp: formatTempF(stored.ambientTemp),
      mcuTemp: formatTempF(stored.mcuTemp),
      humidity: stored.humidity != null ? `${Math.round(stored.humidity)}%` : undefined,
      leftOuter: { value: stored.leftOuterTemp, display: formatTempF(stored.leftOuterTemp), colorClass: tempToColorF(stored.leftOuterTemp) },
      leftCenter: { value: stored.leftCenterTemp, display: formatTempF(stored.leftCenterTemp), colorClass: tempToColorF(stored.leftCenterTemp) },
      leftInner: { value: stored.leftInnerTemp, display: formatTempF(stored.leftInnerTemp), colorClass: tempToColorF(stored.leftInnerTemp) },
      rightOuter: { value: stored.rightOuterTemp, display: formatTempF(stored.rightOuterTemp), colorClass: tempToColorF(stored.rightOuterTemp) },
      rightCenter: { value: stored.rightCenterTemp, display: formatTempF(stored.rightCenterTemp), colorClass: tempToColorF(stored.rightCenterTemp) },
      rightInner: { value: stored.rightInnerTemp, display: formatTempF(stored.rightInnerTemp), colorClass: tempToColorF(stored.rightInnerTemp) },
    }
  }, [liveFrame, latestBedTemp.data])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-sky-400">▦</span>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Sensor Matrix</h3>
          {data?.source === 'stored' && (
            <span className="text-[8px] text-zinc-600">(stored)</span>
          )}
        </div>
        {data?.timestamp && (
          <span className="text-[10px] text-zinc-600">
            {formatTimestamp(data.timestamp)}
          </span>
        )}
      </div>

      {!data ? (
        <div className="flex h-36 items-center justify-center rounded-xl bg-zinc-900">
          <span className="text-xs text-zinc-600">
            {latestBedTemp.isLoading ? 'Loading temperature data...' : 'Waiting for temperature data...'}
          </span>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Environment row */}
          <div className="flex gap-1.5 sm:gap-2">
            <div className="flex flex-1 flex-col items-center rounded-lg bg-zinc-900 p-1.5 sm:p-2">
              <span className="text-[8px] font-medium uppercase text-zinc-500 sm:text-[9px]">Ambient</span>
              <span className="text-[13px] font-semibold text-zinc-200 sm:text-sm">
                {data.ambientTemp}
              </span>
            </div>
            <div className="flex flex-1 flex-col items-center rounded-lg bg-zinc-900 p-1.5 sm:p-2">
              <span className="text-[8px] font-medium uppercase text-zinc-500 sm:text-[9px]">MCU</span>
              <span className="text-[13px] font-semibold text-zinc-200 sm:text-sm">
                {data.mcuTemp}
              </span>
            </div>
            {data.humidity !== undefined && (
              <div className="flex flex-1 flex-col items-center rounded-lg bg-zinc-900 p-1.5 sm:p-2">
                <span className="text-[8px] font-medium uppercase text-zinc-500 sm:text-[9px]">Humidity</span>
                <span className="text-[13px] font-semibold text-zinc-200 sm:text-sm">
                  {data.humidity}
                </span>
              </div>
            )}
          </div>

          {/* Temperature matrix: Left | Right columns, Outer/Center/Inner rows */}
          <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
            {/* Left column header */}
            <div className="text-center text-[10px] font-semibold text-sky-400">Left</div>
            <div className="text-center text-[10px] font-semibold text-teal-400">Right</div>

            {/* Outer zone */}
            <TempCellFormatted display={data.leftOuter.display} colorClass={data.leftOuter.colorClass} label="Left" zone="Outer" />
            <TempCellFormatted display={data.rightOuter.display} colorClass={data.rightOuter.colorClass} label="Right" zone="Outer" />

            {/* Center zone */}
            <TempCellFormatted display={data.leftCenter.display} colorClass={data.leftCenter.colorClass} label="Left" zone="Center" />
            <TempCellFormatted display={data.rightCenter.display} colorClass={data.rightCenter.colorClass} label="Right" zone="Center" />

            {/* Inner zone */}
            <TempCellFormatted display={data.leftInner.display} colorClass={data.leftInner.colorClass} label="Left" zone="Inner" />
            <TempCellFormatted display={data.rightInner.display} colorClass={data.rightInner.colorClass} label="Right" zone="Inner" />
          </div>
        </div>
      )}
    </div>
  )
}
