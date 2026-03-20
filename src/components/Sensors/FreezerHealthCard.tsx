'use client'

import { useMemo } from 'react'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { FrzTempFrame, FrzHealthFrame, FrzThermFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { Snowflake, Fan, Droplets, Gauge, AlertTriangle, CheckCircle } from 'lucide-react'

function formatTimestamp(ts: number | undefined): string {
  if (!ts) return '--'
  const date = new Date(ts * 1000)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface MetricItemProps {
  icon: React.ReactNode
  label: string
  value: string
  subLabel?: string
  status?: 'ok' | 'warn' | 'error'
}

function MetricItem({ icon, label, value, subLabel, status = 'ok' }: MetricItemProps) {
  const statusColor = {
    ok: 'text-emerald-400',
    warn: 'text-amber-400',
    error: 'text-red-400',
  }[status]

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-zinc-900 p-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] font-medium text-zinc-500">{label}</div>
        <div className={`text-sm font-semibold tabular-nums ${statusColor}`}>
          {value}
        </div>
        {subLabel && (
          <div className="text-[9px] text-zinc-600">{subLabel}</div>
        )}
      </div>
    </div>
  )
}

/**
 * Freezer/thermal system health card.
 * Displays water temperatures, TEC current, pump RPM, fan RPM, and water level.
 *
 * Combines live WebSocket frames (frzTemp, frzHealth, frzTherm) with tRPC data:
 * - environment.getLatestFreezerTemp for stored freezer temps when WS is not streaming
 * - waterLevel.getLatest for current water level status
 * - waterLevel.getTrend for 24h water level trend
 * - waterLevel.getAlerts for active water level alerts
 */
export function FreezerHealthCard() {
  const { unit, formatTemp, formatConverted } = useTemperatureUnit()

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

  // tRPC: water level data
  // Flowrate from live frzHealth frames (per-side, °C)
  const leftFlowrate = frzHealth ? (frzHealth as unknown as { left: { temps?: { flowrate?: number } } }).left?.temps?.flowrate ?? null : null
  const rightFlowrate = frzHealth ? (frzHealth as unknown as { right: { temps?: { flowrate?: number } } }).right?.temps?.flowrate ?? null : null

  // Bottom fan from live frzHealth (top fan already in frzHealth.fan.rpm)
  const bottomFanRpm = frzHealth ? (frzHealth as unknown as { fan: { bottom?: { rpm?: number } } }).fan?.bottom?.rpm ?? null : null

  const waterLevelLatest = trpc.waterLevel.getLatest.useQuery(
    {},
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )


  const hasLiveData = frzTemp || frzHealth || frzTherm
  const hasTrpcData = latestFreezerTemp.data
  const hasData = hasLiveData || hasTrpcData
  const latestTs = Math.max(frzTemp?.ts ?? 0, frzHealth?.ts ?? 0, frzTherm?.ts ?? 0)

  // Use tRPC freezer temps as fallback when no live data
  const freezerTempData = frzTemp
    ? {
        leftWater: formatTemp(frzTemp.left),
        rightWater: formatTemp(frzTemp.right),
        ambient: formatTemp(frzTemp.amb),
        heatsink: formatTemp(frzTemp.hs),
        source: 'live' as const,
      }
    : hasTrpcData
      ? {
          leftWater: formatConverted(latestFreezerTemp.data?.leftWaterTemp),
          rightWater: formatConverted(latestFreezerTemp.data?.rightWaterTemp),
          ambient: formatConverted(latestFreezerTemp.data?.ambientTemp),
          heatsink: formatConverted(latestFreezerTemp.data?.heatsinkTemp),
          source: 'stored' as const,
        }
      : null

  const waterLevel = waterLevelLatest.data

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-zinc-500">⚙</span>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">System</h3>
        </div>
        <div className="flex items-center gap-2">
          {freezerTempData?.source === 'stored' && (
            <span className="text-[8px] text-zinc-600">(stored)</span>
          )}
          {hasLiveData && (
            <span className="text-[10px] text-zinc-600">
              {formatTimestamp(latestTs || undefined)}
            </span>
          )}
        </div>
      </div>

      {!hasData ? (
        <div className="flex h-24 items-center justify-center rounded-xl bg-zinc-900">
          <span className="text-xs text-zinc-600">Waiting for freezer data...</span>
        </div>
      ) : (
        <div className="space-y-2">
          {/* Paired left/right metrics */}
          <div className="grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-1.5 items-center">
            {/* Column headers */}
            <div />
            <div className="text-center text-[9px] font-semibold text-sky-400">Left</div>
            <div className="text-center text-[9px] font-semibold text-teal-400">Right</div>

            {/* Water temps */}
            {freezerTempData && (
              <>
                <RowLabel icon={<Snowflake size={12} />} label="Water" color="text-blue-400" />
                <MetricCell value={freezerTempData.leftWater} />
                <MetricCell value={freezerTempData.rightWater} />
              </>
            )}

            {/* TEC current */}
            {frzHealth && (
              <>
                <RowLabel icon={<Gauge size={12} />} label="TEC" color="text-purple-400" />
                <MetricCell value={`${frzHealth.left.tecCurrent.toFixed(2)} A`} warn={frzHealth.left.tecCurrent > 5} />
                <MetricCell value={`${frzHealth.right.tecCurrent.toFixed(2)} A`} warn={frzHealth.right.tecCurrent > 5} />
              </>
            )}

            {/* Pump RPM */}
            {frzHealth && (
              <>
                <RowLabel icon={<Droplets size={12} />} label="Pump" color="text-blue-400" />
                <MetricCell value={`${frzHealth.left.pumpRpm} RPM`} warn={frzHealth.left.pumpRpm === 0} />
                <MetricCell value={`${frzHealth.right.pumpRpm} RPM`} warn={frzHealth.right.pumpRpm === 0} />
              </>
            )}

            {/* Thermal control signal */}
            {frzTherm && (
              <>
                <RowLabel icon={<Gauge size={12} />} label="Therm" color="text-zinc-400" />
                <MetricCell value={typeof frzTherm.left === 'number' ? frzTherm.left.toFixed(1) : '--'} />
                <MetricCell value={typeof frzTherm.right === 'number' ? frzTherm.right.toFixed(1) : '--'} />
              </>
            )}
          </div>

          {/* System-wide metrics (not per-side) */}
          <div className="grid grid-cols-3 gap-1.5">
            {frzHealth && (
              <MetricItem
                icon={<Fan size={16} className="text-cyan-400" />}
                label="Fan"
                value={`${frzHealth.fan.rpm} RPM`}
                status={frzHealth.fan.rpm < 100 ? 'warn' : 'ok'}
              />
            )}
            {freezerTempData && (
              <>
                <MetricItem
                  icon={<Gauge size={16} className="text-orange-400" />}
                  label="Heatsink"
                  value={freezerTempData.heatsink}
                />
                <MetricItem
                  icon={<Gauge size={16} className="text-zinc-400" />}
                  label="Ambient"
                  value={freezerTempData.ambient}
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* Flowrate + water status */}
      {(leftFlowrate != null || rightFlowrate != null || waterLevel) && (
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center gap-1.5">
            <Droplets size={10} className="text-blue-400" />
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Flow</h4>
          </div>
          <div className="grid grid-cols-[auto_1fr_1fr] gap-x-2 gap-y-1.5 items-center">
            <div />
            <div className="text-center text-[9px] font-semibold text-sky-400">Left</div>
            <div className="text-center text-[9px] font-semibold text-teal-400">Right</div>

            <RowLabel icon={<Gauge size={12} />} label="Flow" color="text-blue-400" />
            <MetricCell value={leftFlowrate != null ? formatTemp(leftFlowrate) : '--'} />
            <MetricCell value={rightFlowrate != null ? formatTemp(rightFlowrate) : '--'} />
          </div>
          {waterLevel && (
            <div className="flex items-center gap-2 rounded-md bg-zinc-800/50 px-2 py-1.5">
              {waterLevel.level === 'low' ? (
                <AlertTriangle size={12} className="text-amber-400" />
              ) : (
                <CheckCircle size={12} className="text-emerald-400" />
              )}
              <span className={`text-[10px] font-medium ${waterLevel.level === 'low' ? 'text-amber-400' : 'text-emerald-400'}`}>
                Water {waterLevel.level === 'ok' ? 'OK' : 'Low'}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function RowLabel({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <div className={`flex items-center gap-1 ${color}`}>
      {icon}
      <span className="text-[9px] font-medium">{label}</span>
    </div>
  )
}

function MetricCell({ value, warn }: { value: string; warn?: boolean }) {
  return (
    <div className={`rounded-md bg-zinc-800/50 px-2 py-1.5 text-center text-[11px] font-medium tabular-nums ${
      warn ? 'text-amber-400' : 'text-zinc-200'
    }`}>
      {value}
    </div>
  )
}

