'use client'

import { SensorAge } from './SensorAge'

import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { FrzHealthFrame, FrzWaterFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { formatDisplayTemp, sensorCToDisplay } from '@/src/lib/tempUtils'
import { Card, SectionLabel, Skeleton, StatusDot, type Tone } from '@/src/components/ds'
import { cn } from '@/lib/utils'
import { WaterTankGauge } from '@/src/components/status/WaterTankGauge'

/** Overcurrent threshold in Amperes. Eight Sleep TECs pull ~10-11.5A during startup
 * circuit calibration and up to 12A under peak thermal demand. Real overcurrent is >13.5A. */
export const TEC_OVERCURRENT_AMPS = 13.5

/** Minimum commanded fan duty percentage before evaluating stalled fan.
 * When the heatsink is cold and thermal power is 0, firmware sets duty to 0% (0 RPM)
 * for silent operation. */
export const FAN_MIN_ACTIVE_DUTY = 20
export const FAN_MIN_RPM = 100

/** Overall freezer verdict from live health + water level. */
export function freezerStatus(
  health: FrzHealthFrame | undefined,
  waterLevel: 'low' | 'ok' | undefined,
  hasData: boolean,
  frzWater?: FrzWaterFrame | undefined,
): { tone: Tone, label: string } {
  if (!hasData) return { tone: 'muted', label: 'No data' }
  const isLow = frzWater
    ? (frzWater.capValid ? frzWater.capLevel <= 1 : !frzWater.hasWater)
    : waterLevel === 'low'
  if (isLow) return { tone: 'warn', label: 'Water low' }
  if (frzWater?.isPriming) return { tone: 'ok', label: 'Priming' }
  if (frzWater?.needsPriming) return { tone: 'warn', label: 'Needs prime' }
  if (health && (health.left.tecCurrent > TEC_OVERCURRENT_AMPS || health.right.tecCurrent > TEC_OVERCURRENT_AMPS)) {
    return { tone: 'warn', label: 'High TEC' }
  }
  if (health && health.fan.duty > FAN_MIN_ACTIVE_DUTY && health.fan.rpm < FAN_MIN_RPM) {
    return { tone: 'warn', label: 'Fan slow' }
  }
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
  const frzWater = useSensorFrame('frzWater')

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
  const hasData = !!(temps || frzHealth || frzTherm || frzWater)

  // First paint with no live frames yet: hold the slot while the stored fallback loads.
  if (!hasData && latestFreezerTemp.isLoading) {
    return (
      <>
        <Skeleton className="h-[46px] min-[900px]:hidden" data-testid="freezer-loading" />
        <Skeleton className="hidden h-[168px] min-[900px]:block" />
      </>
    )
  }
  const status = freezerStatus(frzHealth, waterLevel, hasData, frzWater)

  const t = (v: number | null | undefined, decimals = 1) =>
    formatDisplayTemp(v, unit, { decimals, includeUnit: false, nullDisplay: '--' })
  const water = temps
    ? (temps.leftWater !== null && temps.rightWater !== null
        ? `${t(temps.leftWater)} / ${t(temps.rightWater)}`
        : t(temps.leftWater ?? temps.rightWater))
    : '--'
  const rpm = (v: number | undefined) => v === undefined ? '--' : v.toLocaleString()

  const tankText = frzWater
    ? (frzWater.isPriming
        ? 'priming…'
        : frzWater.needsPriming
          ? 'needs prime'
          : frzWater.capValid
            ? `tank ${frzWater.capLevel}/5`
            : `water ${frzWater.hasWater ? 'ok' : 'low'}`)
    : (waterLevel && `water ${waterLevel}`)

  const secondary = [
    frzHealth && `fan ${frzHealth.fan.rpm.toLocaleString()} rpm`,
    frzHealth && `tec ${frzHealth.left.tecCurrent.toFixed(1)}/${frzHealth.right.tecCurrent.toFixed(1)} A`,
    frzTherm && `therm ${frzTherm.left.toFixed(1)}/${frzTherm.right.toFixed(1)}`,
    temps && `hub ${t(temps.ambient)}`,
    tankText,
  ].filter(Boolean) as string[]

  return (
    <>
      {/* Phones: one-line summary row */}
      <Card className="flex-row items-center gap-2.5 px-4 py-3.5 min-[900px]:hidden">
        <span className="sp-label">Freezer</span>
        <StatusDot tone={status.tone} label={status.label} className="text-[13px]" />
        <WaterTankGauge
          capLevel={frzWater?.capLevel}
          capValid={frzWater?.capValid}
          isPriming={frzWater?.isPriming}
          needsPriming={frzWater?.needsPriming}
          waterLevel={waterLevel}
          className="ml-auto"
        />
        <span className={cn('truncate font-mono text-xs text-fg-2', !frzWater?.capValid && 'ml-auto')}>
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
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-mono text-lg font-light">{water}</span>
              <WaterTankGauge
                capLevel={frzWater?.capLevel}
                capValid={frzWater?.capValid}
                isPriming={frzWater?.isPriming}
                needsPriming={frzWater?.needsPriming}
                waterLevel={waterLevel}
              />
            </div>
            <div className="text-[11px] text-fg-2">Water</div>
          </div>
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
