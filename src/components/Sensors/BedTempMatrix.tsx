'use client'

import { SensorAge } from './SensorAge'

import dynamic from 'next/dynamic'
import { useEffect, useState } from 'react'
import { latestThermalReading, thermalColor, thermalState, THERMAL_STALE_SECONDS } from '@/src/components/ThermalBed/thermalData'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatDisplayTemp, sensorCToDisplay } from '@/src/lib/tempUtils'
import { Card, SectionLabel, Skeleton } from '@/src/components/ds'

const ThermalCanvas = dynamic(() => import('@/src/components/ThermalBed/ThermalCanvas'), { ssr: false, loading: () => <div className="h-[300px] min-[600px]:h-[360px]" /> })

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
 * (left outer → right outer), with a shared 3D view on a fixed Celsius scale.
 *
 * Combines live WebSocket frames with tRPC fallback from
 * environment.getLatestBedTemp for initial data before WS connects.
 */
export function BedTempMatrix() {
  const bedTemp = useSensorFrame('bedTemp')
  const bedTemp2 = useSensorFrame('bedTemp2')
  const { unit } = useTemperatureUnit()

  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now() / 1000), 5000)
    return () => clearInterval(timer)
  }, [])
  const live = latestThermalReading(bedTemp, bedTemp2)
  const latestBedTemp = trpc.environment.getLatestBedTemp.useQuery(
    { unit: 'C' },
    { refetchInterval: 30_000, staleTime: 15_000, enabled: !live || now - live.ts >= THERMAL_STALE_SECONDS },
  )
  const reading = latestThermalReading(bedTemp, bedTemp2, latestBedTemp.data)
  const stale = !reading || now - reading.ts >= THERMAL_STALE_SECONDS
  const source = reading?.source === 'stored' ? latestBedTemp.data : bedTemp?.ts === reading?.ts ? bedTemp : bedTemp2
  const c = (value: number | null | undefined) => sensorCToDisplay(value ?? null, unit)
  const cells = reading ? [...reading.left, ...[...reading.right].reverse()] : []
  const data = reading
    ? {
        source: reading.source,
        cells: cells.map(c),
        ambient: c(source?.ambientTemp),
        mcu: c(source?.mcuTemp),
        humidity: source?.humidity,
      }
    : null
  const states = {
    left: thermalState(reading?.left ?? [null, null, null], undefined, stale),
    right: thermalState(reading?.right ?? [null, null, null], undefined, stale),
  }

  const fmt = (v: number | null) => formatDisplayTemp(v, unit, { decimals: 1, includeUnit: false, nullDisplay: '--' })

  return (
    <Card className="col-span-full gap-2.5 overflow-hidden px-4 py-3.5">
      <SectionLabel right={(
        <span className="flex items-center gap-2">
          <SensorAge timestamp={reading?.ts} />
          °
          {unit}
        </span>
      )}
      >
        Bed temp matrix
        {data && stale && <span className="normal-case tracking-normal text-fg-3">Stale readings</span>}
        {data?.source === 'stored' && <span className="normal-case tracking-normal text-fg-3">stored</span>}
      </SectionLabel>

      <ThermalCanvas states={states} focus={null} unit={unit} view="regions" />
      <div className="mx-auto flex w-full max-w-72 items-center gap-3 font-mono text-[10px] text-fg-2">
        <span>{fmt(c(18))}</span>
        <div className="h-1.5 flex-1 rounded-full" style={{ background: 'var(--thermal-ramp)' }} />
        <span>{fmt(c(36))}</span>
      </div>

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
                  style={{ background: `color-mix(in srgb, ${thermalColor(stale ? null : cells[i])} 30%, var(--surface-card))` }}
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

      <p className="text-[11px] leading-relaxed text-fg-3">
        Six measured regions: outer, center and inner on each side. Colors use a fixed temperature scale; gray means missing or stale data. Regions are schematic; head-to-foot detail is not measured.
      </p>

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
