'use client'

import { SensorAge } from './SensorAge'

import { useMemo } from 'react'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { BedTempFrame, BedTemp2Frame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatDisplayTemp, sensorCToDisplay } from '@/src/lib/tempUtils'
import { Card, SectionLabel, Skeleton } from '@/src/components/ds'

const CELL_LABELS = ['L out', 'L ctr', 'L in', 'R in', 'R ctr', 'R out'] as const

/**
 * Cell tint relative to the bed's mean: cooler than average leans on the cool
 * accent, warmer on the warm accent; strength grows with the deviation.
 */
export function cellTint(value: number | null, mean: number | null): string {
  if (value === null || mean === null) return 'var(--surface-active)'
  const diff = value - mean
  const accent = diff < 0 ? 'var(--accent-cool)' : 'var(--accent-warm)'
  const pct = Math.round(14 + Math.min(Math.abs(diff) / 2, 1) * 26)
  return `color-mix(in srgb, ${accent} ${pct}%, var(--surface-card))`
}

/**
 * Bed temperature matrix: the six surface sensors laid out across the bed
 * (left outer → right outer), tinted cool/warm around the bed's mean.
 *
 * Combines live WebSocket frames with tRPC fallback from
 * environment.getLatestBedTemp for initial data before WS connects.
 */
export function BedTempMatrix() {
  const bedTemp = useSensorFrame('bedTemp')
  const bedTemp2 = useSensorFrame('bedTemp2')
  const { unit } = useTemperatureUnit()

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

  // Unified source in the user's display unit: live frames are Celsius,
  // stored rows are already converted by the endpoint.
  const data = useMemo(() => {
    if (liveFrame) {
      const c = (v: number | null) => sensorCToDisplay(v, unit)
      return {
        source: 'live' as const,
        cells: [
          liveFrame.leftOuterTemp, liveFrame.leftCenterTemp, liveFrame.leftInnerTemp,
          liveFrame.rightInnerTemp, liveFrame.rightCenterTemp, liveFrame.rightOuterTemp,
        ].map(c),
        ambient: c(liveFrame.ambientTemp),
        mcu: c(liveFrame.mcuTemp),
        humidity: liveFrame.humidity,
      }
    }
    const stored = latestBedTemp.data
    if (!stored) return null
    return {
      source: 'stored' as const,
      cells: [
        stored.leftOuterTemp, stored.leftCenterTemp, stored.leftInnerTemp,
        stored.rightInnerTemp, stored.rightCenterTemp, stored.rightOuterTemp,
      ],
      ambient: stored.ambientTemp,
      mcu: stored.mcuTemp,
      humidity: stored.humidity,
    }
  }, [liveFrame, latestBedTemp.data, unit])

  const mean = useMemo(() => {
    const vals = data?.cells.filter((v): v is number => v !== null) ?? []
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }, [data])

  const fmt = (v: number | null) => formatDisplayTemp(v, unit, { decimals: 1, includeUnit: false, nullDisplay: '--' })

  return (
    <Card className="gap-2.5 px-4 py-3.5">
      <SectionLabel right={(
        <span className="flex items-center gap-2">
          <SensorAge timestamp={liveFrame?.ts} />
          °
          {unit}
        </span>
      )}
      >
        Bed temp matrix
        {data?.source === 'stored' && <span className="normal-case tracking-normal text-fg-3">stored</span>}
      </SectionLabel>

      {!data
        ? (
            latestBedTemp.isLoading
              ? <Skeleton className="h-[38px] rounded-[5px]" />
              : (
                  <div className="flex h-[38px] items-center justify-center rounded-[5px] bg-active text-xs text-fg-3">
                    Waiting for temperature data
                  </div>
                )
          )
        : (
            <div className="grid grid-cols-6 gap-1 text-center font-mono text-[11px] min-[900px]:text-xs">
              {data.cells.map((v, i) => (
                <div
                  key={CELL_LABELS[i]}
                  className="rounded-[5px] py-[9px] min-[900px]:py-2.5"
                  style={{ background: cellTint(v, mean) }}
                  title={CELL_LABELS[i]}
                >
                  {fmt(v)}
                </div>
              ))}
            </div>
          )}

      <div className="grid grid-cols-6 text-center text-[10px] text-fg-3">
        {CELL_LABELS.map(l => <span key={l}>{l}</span>)}
      </div>

      {data && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-2.5 font-mono text-xs text-fg-2">
          <span>
            {'ambient '}
            <span className="text-fg">{fmt(data.ambient)}</span>
          </span>
          <span>
            {'mcu '}
            <span className="text-fg">{fmt(data.mcu)}</span>
          </span>
          {data.humidity != null && (
            <span>
              {'rh '}
              <span className="text-fg">{`${Math.round(data.humidity)}%`}</span>
            </span>
          )}
        </div>
      )}
    </Card>
  )
}
