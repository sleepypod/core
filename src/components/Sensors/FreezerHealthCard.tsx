'use client'

import { SensorAge } from './SensorAge'

import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { FrzHealthFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatDisplayTemp, sensorCToDisplay } from '@/src/lib/tempUtils'
import { Card, SectionLabel, Skeleton, StatusDot, type Tone } from '@/src/components/ds'

/** Overall freezer verdict from live health + water level. */
export function freezerStatus(
  health: FrzHealthFrame | undefined,
  waterLevel: 'low' | 'ok' | undefined,
  hasData: boolean,
): { tone: Tone, label: string } {
  if (!hasData) return { tone: 'muted', label: 'No data' }
  if (waterLevel === 'low') return { tone: 'warn', label: 'Water low' }
  if (health && (health.left.tecCurrent > 5 || health.right.tecCurrent > 5)) return { tone: 'warn', label: 'High TEC' }
  if (health && health.fan.rpm < 100) return { tone: 'warn', label: 'Fan slow' }
  return { tone: 'ok', label: 'Normal' }
}

/**
 * Freezer/thermal system health card: heatsink, water, pump rpm per side,
 * plus fan / TEC / water level as a secondary line.
 *
 * Combines live WebSocket frames (frzTemp, frzHealth, frzTherm) with tRPC data:
 * - environment.getLatestFreezerTemp for stored freezer temps when WS is not streaming
 * - waterLevel.getLatest for current water level status
 */
export function FreezerHealthCard() {
  const { unit } = useTemperatureUnit()

  // Live WebSocket frames
  const frzTemp = useSensorFrame('frzTemp')
  const frzHealth = useSensorFrame('frzHealth')
  const frzTherm = useSensorFrame('frzTherm')

  // tRPC: latest freezer temp from DB (fallback when WS hasn't sent data)
  const latestFreezerTemp = trpc.environment.getLatestFreezerTemp.useQuery(
    { unit },
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )

  const waterLevelLatest = trpc.waterLevel.getLatest.useQuery(
    {},
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )

  // Display-unit numbers: live frames are Celsius, stored rows pre-converted
  const temps = frzTemp
    ? {
        leftWater: sensorCToDisplay(frzTemp.left, unit),
        rightWater: sensorCToDisplay(frzTemp.right, unit),
        ambient: sensorCToDisplay(frzTemp.amb, unit),
        heatsink: sensorCToDisplay(frzTemp.hs, unit),
        source: 'live' as const,
      }
    : latestFreezerTemp.data
      ? {
          leftWater: latestFreezerTemp.data.leftWaterTemp ?? null,
          rightWater: latestFreezerTemp.data.rightWaterTemp ?? null,
          ambient: latestFreezerTemp.data.ambientTemp ?? null,
          heatsink: latestFreezerTemp.data.heatsinkTemp ?? null,
          source: 'stored' as const,
        }
      : null

  const waterLevel = waterLevelLatest.data?.level as 'low' | 'ok' | undefined
  const hasData = !!(temps || frzHealth || frzTherm)

  // First paint with no live frames yet: hold the slot while the stored fallback loads.
  if (!hasData && latestFreezerTemp.isLoading) {
    return (
      <>
        <Skeleton className="h-[46px] min-[900px]:hidden" data-testid="freezer-loading" />
        <Skeleton className="hidden h-[168px] min-[900px]:block" />
      </>
    )
  }
  const status = freezerStatus(frzHealth, waterLevel, hasData)

  const t = (v: number | null | undefined, decimals = 1) =>
    formatDisplayTemp(v, unit, { decimals, includeUnit: false, nullDisplay: '--' })
  const water = temps
    ? (temps.leftWater !== null && temps.rightWater !== null
        ? `${t(temps.leftWater)} / ${t(temps.rightWater)}`
        : t(temps.leftWater ?? temps.rightWater))
    : '--'
  const rpm = (v: number | undefined) => v === undefined ? '--' : v.toLocaleString()

  const secondary = [
    frzHealth && `fan ${frzHealth.fan.rpm.toLocaleString()} rpm`,
    frzHealth && `tec ${frzHealth.left.tecCurrent.toFixed(1)}/${frzHealth.right.tecCurrent.toFixed(1)} A`,
    frzTherm && `therm ${frzTherm.left.toFixed(1)}/${frzTherm.right.toFixed(1)}`,
    temps && `hub ${t(temps.ambient)}`,
    waterLevel && `water ${waterLevel}`,
  ].filter(Boolean) as string[]

  return (
    <>
      {/* Phones: one-line summary row */}
      <Card className="flex-row items-center gap-2.5 px-4 py-3.5 min-[900px]:hidden">
        <span className="sp-label">Freezer</span>
        <StatusDot tone={status.tone} label={status.label} className="text-[13px]" />
        <span className="ml-auto truncate font-mono text-xs text-fg-2">
          {temps ? `${t(temps.heatsink, 0)} sink · ${t(temps.leftWater ?? temps.rightWater, 0)} water` : '--'}
        </span>
      </Card>

      <Card className="hidden gap-2.5 px-4 py-3.5 min-[900px]:flex">
        <SectionLabel right={<StatusDot tone={status.tone} label={status.label} mono className="tracking-normal" />}>
          Freezer health
          {temps?.source === 'stored' && <span className="normal-case tracking-normal text-fg-3">stored</span>}
          <SensorAge timestamp={frzHealth?.ts} />
        </SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          <BigStat value={temps ? `${t(temps.heatsink)}` : '--'} label="Heatsink" warn={false} />
          <BigStat value={water} label="Water" warn={false} />
          <BigStat value={rpm(frzHealth?.left.pumpRpm)} label="Pump L · rpm" warn={frzHealth?.left.pumpRpm === 0} />
          <BigStat value={rpm(frzHealth?.right.pumpRpm)} label="Pump R · rpm" warn={frzHealth?.right.pumpRpm === 0} />
        </div>
        {secondary.length > 0 && (
          <div className="border-t border-line pt-2.5 font-mono text-[11px] leading-relaxed text-fg-2">
            {secondary.join(' · ')}
          </div>
        )}
      </Card>
    </>
  )
}

function BigStat({ value, label, warn }: { value: string, label: string, warn: boolean }) {
  return (
    <div className="min-w-0">
      <div className={`truncate font-mono text-lg font-light ${warn ? 'text-warn' : ''}`}>{value}</div>
      <div className="text-[11px] text-fg-2">{label}</div>
    </div>
  )
}
