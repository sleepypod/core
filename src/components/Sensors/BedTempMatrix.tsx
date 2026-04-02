'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import { Brain, PersonStanding, Footprints } from 'lucide-react'
import { useSensorFrame, useOnSensorFrame } from '@/src/hooks/useSensorStream'
import type { BedTempFrame, BedTemp2Frame, CapSense2Frame, SensorFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'

/**
 * Map a temperature (Celsius) to a color string.
 * Blue (18C) → Green (28C) → Orange (38C).
 */
function tempToColor(tempC: number | null | undefined): string {
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

// formatTemp and formatTempF are now provided by useTemperatureUnit hook
// (injected into the component via closure in the useMemo)

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '--'
  const date = new Date(ts * 1000)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// --- Cap sense variance tracking ---

const VARIANCE_WINDOW = 20
const ACTIVITY_THRESHOLD = 0.15 // glow threshold matching iOS

function computeStddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const sq = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  return Math.sqrt(sq)
}

interface CapVariance {
  // per-channel stddev, indices 0-5 (channels 6,7 are REF, excluded)
  left: number[]
  right: number[]
}

// --- Cell components ---

const ZONE_LABELS = ['Head', 'Torso', 'Legs'] as const
const ZONE_ICONS = [
  <Brain key="head" size={9} />,
  <PersonStanding key="torso" size={9} />,
  <Footprints key="legs" size={9} />,
]

/** Center zone label with icon, displayed between left and right columns. */
function ZoneLabel({ zone }: { zone: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-0.5">
      <span className="text-zinc-600">{ZONE_ICONS[zone]}</span>
      <span className="text-[7px] font-semibold uppercase tracking-wider text-zinc-600">
        {ZONE_LABELS[zone]}
      </span>
    </div>
  )
}

/**
 * Bed temperature matrix display.
 * Shows a 3×2 grid of temperature readings matching the iOS BedMatrixView:
 * Head / Torso / Legs zones for Left and Right sides.
 * Each cell shows: temp (°F, bold), cap sensor raw value (small dim), variance (tiny).
 * An activity glow appears when zone variance > 0.15.
 *
 * Combines live WebSocket frames with tRPC fallback from
 * environment.getLatestBedTemp for initial data before WS connects.
 */
export function BedTempMatrix() {
  const bedTemp = useSensorFrame('bedTemp')
  const bedTemp2 = useSensorFrame('bedTemp2')
  const capSense2 = useSensorFrame('capSense2') as CapSense2Frame | undefined

  const { unit, formatTemp, formatConverted } = useTemperatureUnit()

  // Prefer bedTemp2 (newer pods)
  const liveFrame: BedTempFrame | BedTemp2Frame | undefined = bedTemp2 ?? bedTemp

  // tRPC fallback: latest bed temp from database (request in user's unit)
  const latestBedTemp = trpc.environment.getLatestBedTemp.useQuery(
    { unit },
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
      // Only used as fallback; stop refetching once live data is flowing
      enabled: !liveFrame,
    },
  )

  // Variance tracking — rolling window of last 20 capSense2 frames
  const leftHistoryRef = useRef<number[][]>([])
  const rightHistoryRef = useRef<number[][]>([])
  const [capVariance, setCapVariance] = useState<CapVariance>({ left: [], right: [] })

  useOnSensorFrame(useCallback((f: SensorFrame) => {
    if (f.type !== 'capSense2') return

    const leftChannels: number[] = Array.isArray(f.left) ? (f.left as number[]) : []
    const rightChannels: number[] = Array.isArray(f.right) ? (f.right as number[]) : []

    leftHistoryRef.current = [...leftHistoryRef.current, leftChannels].slice(-VARIANCE_WINDOW)
    rightHistoryRef.current = [...rightHistoryRef.current, rightChannels].slice(-VARIANCE_WINDOW)

    // Compute stddev for channels 0-5 (skip REF 6,7)
    const leftVar: number[] = []
    const rightVar: number[] = []
    for (let ch = 0; ch < 6; ch++) {
      leftVar.push(computeStddev(leftHistoryRef.current.map(h => h[ch] ?? 0)))
      rightVar.push(computeStddev(rightHistoryRef.current.map(h => h[ch] ?? 0)))
    }

    setCapVariance({ left: leftVar, right: rightVar })
  }, []))

  // Build a unified data source: live WS frame takes priority, tRPC as fallback
  const data = useMemo(() => {
    if (liveFrame) {
      // Live frames are in Celsius — formatTemp converts to user's preferred unit
      return {
        source: 'live' as const,
        timestamp: liveFrame.ts,
        ambientTemp: formatTemp(liveFrame.ambientTemp),
        mcuTemp: formatTemp(liveFrame.mcuTemp),
        humidity: typeof liveFrame.humidity === 'number' ? `${liveFrame.humidity.toFixed(0)}%` : undefined,
        leftHead: { display: formatTemp(liveFrame.leftOuterTemp), colorClass: tempToColor(liveFrame.leftOuterTemp) },
        leftTorso: { display: formatTemp(liveFrame.leftCenterTemp), colorClass: tempToColor(liveFrame.leftCenterTemp) },
        leftLegs: { display: formatTemp(liveFrame.leftInnerTemp), colorClass: tempToColor(liveFrame.leftInnerTemp) },
        rightHead: { display: formatTemp(liveFrame.rightOuterTemp), colorClass: tempToColor(liveFrame.rightOuterTemp) },
        rightTorso: { display: formatTemp(liveFrame.rightCenterTemp), colorClass: tempToColor(liveFrame.rightCenterTemp) },
        rightLegs: { display: formatTemp(liveFrame.rightInnerTemp), colorClass: tempToColor(liveFrame.rightInnerTemp) },
      }
    }

    const stored = latestBedTemp.data
    if (!stored) return null

    // Stored data already converted to user's unit by the tRPC endpoint
    return {
      source: 'stored' as const,
      timestamp: stored.timestamp ? Math.floor(new Date(stored.timestamp as string).getTime() / 1000) : undefined,
      ambientTemp: formatConverted(stored.ambientTemp),
      mcuTemp: formatConverted(stored.mcuTemp),
      humidity: stored.humidity != null ? `${Math.round(stored.humidity)}%` : undefined,
      leftHead: { display: formatConverted(stored.leftOuterTemp), colorClass: tempToColorF(stored.leftOuterTemp) },
      leftTorso: { display: formatConverted(stored.leftCenterTemp), colorClass: tempToColorF(stored.leftCenterTemp) },
      leftLegs: { display: formatConverted(stored.leftInnerTemp), colorClass: tempToColorF(stored.leftInnerTemp) },
      rightHead: { display: formatConverted(stored.rightOuterTemp), colorClass: tempToColorF(stored.rightOuterTemp) },
      rightTorso: { display: formatConverted(stored.rightCenterTemp), colorClass: tempToColorF(stored.rightCenterTemp) },
      rightLegs: { display: formatConverted(stored.rightInnerTemp), colorClass: tempToColorF(stored.rightInnerTemp) },
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveFrame, latestBedTemp.data, unit])

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

      {!data
        ? (
            <div className="flex h-36 items-center justify-center rounded-xl bg-zinc-900">
              <span className="text-xs text-zinc-600">
                {latestBedTemp.isLoading ? 'Loading temperature data...' : 'Waiting for temperature data...'}
              </span>
            </div>
          )
        : (
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

              {/* Sensor matrix: 2 cells per zone per side (matching iOS BedMatrixView) */}
              {/* Grid: [L ch0] [L ch1] | Zone label | [R ch0] [R ch1] */}
              <div className="grid grid-cols-[1fr_1fr_auto_1fr_1fr] gap-0.5">
                {/* Column headers */}
                <div className="col-span-2 text-center text-[10px] font-semibold text-sky-400">Left</div>
                <div />
                {' '}
                {/* zone label spacer */}
                <div className="col-span-2 text-center text-[10px] font-semibold text-teal-400">Right</div>

                {/* 3 zones: Head (ch 0,1), Torso (ch 2,3), Legs (ch 4,5) */}
                {[0, 1, 2].map((zone) => {
                  const zoneData = [data.leftHead, data.leftTorso, data.leftLegs][zone]
                  const zoneDataR = [data.rightHead, data.rightTorso, data.rightLegs][zone]
                  const ch0 = zone * 2
                  const ch1 = zone * 2 + 1
                  const leftCap = capSense2?.left
                  const rightCap = capSense2?.right

                  return (
                    <SensorMatrixRow
                      key={zone}
                      zone={zone}
                      leftTemp={zoneData}
                      rightTemp={zoneDataR}
                      leftCap0={leftCap?.[ch0] ?? null}
                      leftCap1={leftCap?.[ch1] ?? null}
                      rightCap0={rightCap?.[ch0] ?? null}
                      rightCap1={rightCap?.[ch1] ?? null}
                      leftVar0={capVariance.left[ch0]}
                      leftVar1={capVariance.left[ch1]}
                      rightVar0={capVariance.right[ch0]}
                      rightVar1={capVariance.right[ch1]}
                    />
                  )
                })}
              </div>

              {/* Legend */}
              <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 pt-1">
                <LegendItem label="Zone temp" example="78.2°" />
                <LegendItem label="Cap raw" example="1.05" dim />
                <LegendItem label="Variance" example="±0.32" dim />
                <div className="flex items-center gap-1">
                  <div className="h-2 w-2 rounded-sm ring-1 ring-sky-400/30 bg-sky-400/5" />
                  <span className="text-[7px] text-zinc-600">= presence detected</span>
                </div>
              </div>
            </div>
          )}
    </div>
  )
}

/** A single sensor cell — shows temp, cap raw value, and per-channel variance. */
function SensorCell({
  temp, capRaw, variance, colorClass,
}: {
  temp: string
  capRaw: number | null
  variance: number | undefined
  colorClass: string
}) {
  const hasActivity = typeof variance === 'number' && variance > ACTIVITY_THRESHOLD
  return (
    <div
      className={[
        'relative flex flex-col items-center justify-center rounded py-1 overflow-hidden',
        colorClass,
        hasActivity ? 'ring-1 ring-sky-400/30' : '',
      ].join(' ')}
    >
      {hasActivity && (
        <div className="pointer-events-none absolute inset-0 rounded bg-sky-400/5" />
      )}
      <span className="text-[11px] font-bold tabular-nums sm:text-xs">{temp}</span>
      {capRaw != null && (
        <span className="text-[6px] tabular-nums text-zinc-400/60">{capRaw.toFixed(2)}</span>
      )}
      {typeof variance === 'number' && (
        <span className={`text-[5px] tabular-nums ${hasActivity ? 'text-sky-400/70' : 'text-zinc-600'}`}>
          ±
          {variance.toFixed(2)}
        </span>
      )}
    </div>
  )
}

/** One zone row: 2 left cells + zone label + 2 right cells */
function SensorMatrixRow({
  zone, leftTemp, rightTemp,
  leftCap0, leftCap1, rightCap0, rightCap1,
  leftVar0, leftVar1, rightVar0, rightVar1,
}: {
  zone: number
  leftTemp: { display: string, colorClass: string }
  rightTemp: { display: string, colorClass: string }
  leftCap0: number | null
  leftCap1: number | null
  rightCap0: number | null
  rightCap1: number | null
  leftVar0: number | undefined
  leftVar1: number | undefined
  rightVar0: number | undefined
  rightVar1: number | undefined
}) {
  return (
    <>
      <SensorCell temp={leftTemp.display} capRaw={leftCap0} variance={leftVar0} colorClass={leftTemp.colorClass} />
      <SensorCell temp={leftTemp.display} capRaw={leftCap1} variance={leftVar1} colorClass={leftTemp.colorClass} />
      <ZoneLabel zone={zone} />
      <SensorCell temp={rightTemp.display} capRaw={rightCap0} variance={rightVar0} colorClass={rightTemp.colorClass} />
      <SensorCell temp={rightTemp.display} capRaw={rightCap1} variance={rightVar1} colorClass={rightTemp.colorClass} />
    </>
  )
}

function LegendItem({ label, example, dim }: { label: string, example: string, dim?: boolean }) {
  return (
    <div className="flex items-center gap-1">
      <span className={`font-mono ${dim ? 'text-[7px] text-zinc-500/60' : 'text-[8px] font-bold text-zinc-300'}`}>{example}</span>
      <span className="text-[7px] text-zinc-600">
        =
        {label}
      </span>
    </div>
  )
}
