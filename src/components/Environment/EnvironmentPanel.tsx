'use client'

import { useState, useMemo } from 'react'
import { Droplets, Thermometer, ThermometerSun, TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { TimeRangeSelector, getDateRangeFromTimeRange, type TimeRange } from './TimeRangeSelector'
import { BedTempChart } from './BedTempChart'
import { HumidityChart } from './HumidityChart'
import { EnvironmentStatCard } from './EnvironmentStatCard'

interface EnvironmentPanelProps {
  unit?: 'F' | 'C'
  /** When true, show both sides' bed temperatures for comparison */
  dualSide?: boolean
}

function CardSection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        {icon}
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {title}
        </h3>
      </div>
      {children}
    </div>
  )
}

export function EnvironmentPanel({ unit = 'F', dualSide = false }: EnvironmentPanelProps) {
  const { side } = useSide()
  const [timeRange, setTimeRange] = useState<TimeRange>('6h')

  const dateRange = useMemo(
    () => getDateRangeFromTimeRange(timeRange),
    [timeRange],
  )

  // Compute limit based on time range — data comes in at ~1min intervals
  const limit = useMemo(() => {
    const hours = parseInt(timeRange)
    return Math.min(hours * 60, 1440)
  }, [timeRange])

  // Fetch historical bed temp data
  const bedTempQuery = trpc.environment.getBedTemp.useQuery(
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit,
      unit,
    },
    {
      refetchInterval: 60_000, // Refetch every minute
      staleTime: 30_000,
    },
  )

  // Fetch latest reading for current values
  const latestQuery = trpc.environment.getLatestBedTemp.useQuery(
    { unit },
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )

  // Fetch summary for the selected time range
  const summaryQuery = trpc.environment.getSummary.useQuery(
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      unit,
    },
    {
      staleTime: 60_000,
    },
  )

  const latest = latestQuery.data
  const summary = summaryQuery.data?.bedTemp
  const isLoading = bedTempQuery.isLoading
  const isError = bedTempQuery.isError

  // Current values — side-aware bed temp
  const currentAmbient = latest?.ambientTemp != null
    ? `${Math.round(latest.ambientTemp)}°${unit}`
    : '--'
  const currentHumidity = latest?.humidity != null
    ? `${Math.round(latest.humidity)}%`
    : '--'

  // Show selected side's bed temperature
  const currentBedTemp = side === 'left'
    ? latest?.leftCenterTemp
    : latest?.rightCenterTemp
  const currentBedTempStr = currentBedTemp != null
    ? `${Math.round(currentBedTemp)}°${unit}`
    : '--'

  // Other side bed temp (for dual-side comparison)
  const otherBedTemp = side === 'left'
    ? latest?.rightCenterTemp
    : latest?.leftCenterTemp
  const otherBedTempStr = otherBedTemp != null
    ? `${Math.round(otherBedTemp)}°${unit}`
    : '--'

  // Summary values — side-aware bed average
  const avgAmbient = summary?.avgAmbientTemp != null
    ? `${Math.round(summary.avgAmbientTemp)}°`
    : '--'
  const minAmbient = summary?.minAmbientTemp != null
    ? `${Math.round(summary.minAmbientTemp)}°`
    : '--'
  const maxAmbient = summary?.maxAmbientTemp != null
    ? `${Math.round(summary.maxAmbientTemp)}°`
    : '--'
  const avgHumidity = summary?.avgHumidity != null
    ? `${Math.round(summary.avgHumidity)}%`
    : '--'
  const avgBedTemp = side === 'left'
    ? summary?.avgLeftCenterTemp
    : summary?.avgRightCenterTemp
  const avgBedTempStr = avgBedTemp != null
    ? `${Math.round(avgBedTemp)}°`
    : '--'

  // Determine ambient trend from summary
  const ambientTrend = useMemo(() => {
    if (!summary?.minAmbientTemp || !summary?.maxAmbientTemp) return null
    const range = summary.maxAmbientTemp - summary.minAmbientTemp
    if (range < 1) return 'stable'
    // Check if latest is closer to max or min
    if (latest?.ambientTemp != null) {
      const mid = (summary.minAmbientTemp + summary.maxAmbientTemp) / 2
      return latest.ambientTemp > mid ? 'warming' : 'cooling'
    }
    return null
  }, [summary, latest])

  return (
    <div className="flex flex-col gap-3 sm:gap-4">
      {/* Time Range Selector */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-300">Environment</h2>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Current Readings Grid — side-aware, dual-side shows both bed temps */}
      {dualSide ? (
        <div className="grid grid-cols-2 gap-2">
          <EnvironmentStatCard
            icon={<Thermometer size={14} />}
            label="Bed Left"
            value={side === 'left' ? currentBedTempStr : otherBedTempStr}
            colorClass="text-[#5cb8e0]"
          />
          <EnvironmentStatCard
            icon={<Thermometer size={14} />}
            label="Bed Right"
            value={side === 'right' ? currentBedTempStr : otherBedTempStr}
            colorClass="text-[#40e0d0]"
          />
          <EnvironmentStatCard
            icon={<ThermometerSun size={14} />}
            label="Ambient"
            value={currentAmbient}
            subValue={ambientTrend === 'warming' ? '↑ warming' : ambientTrend === 'cooling' ? '↓ cooling' : undefined}
            colorClass="text-[#d4a84a]"
          />
          <EnvironmentStatCard
            icon={<Droplets size={14} />}
            label="Humidity"
            value={currentHumidity}
            colorClass="text-[#4a90d9]"
          />
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          <EnvironmentStatCard
            icon={<Thermometer size={14} />}
            label={`Bed ${side === 'left' ? 'L' : 'R'}`}
            value={currentBedTempStr}
            colorClass={side === 'left' ? 'text-[#5cb8e0]' : 'text-[#40e0d0]'}
          />
          <EnvironmentStatCard
            icon={<ThermometerSun size={14} />}
            label="Ambient"
            value={currentAmbient}
            subValue={ambientTrend === 'warming' ? '↑ warming' : ambientTrend === 'cooling' ? '↓ cooling' : undefined}
            colorClass="text-[#d4a84a]"
          />
          <EnvironmentStatCard
            icon={<Droplets size={14} />}
            label="Humidity"
            value={currentHumidity}
            colorClass="text-[#4a90d9]"
          />
        </div>
      )}

      {/* Bed Temperature Trend Chart */}
      <CardSection
        title="Bed Temperature Trend"
        icon={
          <TrendIcon trend={ambientTrend} />
        }
      >
        {isLoading ? (
          <div className="flex h-[200px] items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
          </div>
        ) : isError ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-red-400">
            Failed to load temperature data
          </div>
        ) : (
          <BedTempChart
            data={bedTempQuery.data ?? []}
            unit={unit}
            showAmbient
            highlightSide={dualSide ? 'both' : side}
          />
        )}

        {/* Summary Stats Row */}
        {summary && (
          <div className="mt-3 flex flex-wrap justify-between gap-y-2 border-t border-zinc-800 pt-3">
            {dualSide ? (
              <>
                <SummaryItem
                  label="Avg Bed L"
                  value={summary.avgLeftCenterTemp != null ? `${Math.round(summary.avgLeftCenterTemp)}°` : '--'}
                />
                <SummaryItem
                  label="Avg Bed R"
                  value={summary.avgRightCenterTemp != null ? `${Math.round(summary.avgRightCenterTemp)}°` : '--'}
                />
              </>
            ) : (
              <SummaryItem label={`Avg Bed ${side === 'left' ? 'L' : 'R'}`} value={avgBedTempStr} />
            )}
            <SummaryItem label="Avg Ambient" value={avgAmbient} />
            <SummaryItem label="Min" value={minAmbient} />
            <SummaryItem label="Max" value={maxAmbient} />
            <SummaryItem label="Humidity" value={avgHumidity} />
          </div>
        )}
      </CardSection>

      {/* Humidity Trend Chart */}
      <CardSection
        title="Humidity"
        icon={<Droplets size={12} className="text-[#4a90d9]" />}
      >
        {isLoading ? (
          <div className="flex h-[140px] items-center justify-center">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
          </div>
        ) : isError ? (
          <div className="flex h-[140px] items-center justify-center text-sm text-red-400">
            Failed to load humidity data
          </div>
        ) : (
          <HumidityChart data={bedTempQuery.data ?? []} />
        )}
      </CardSection>
    </div>
  )
}

function TrendIcon({ trend }: { trend: string | null }) {
  if (trend === 'warming') return <TrendingUp size={12} className="text-[#d4a84a]" />
  if (trend === 'cooling') return <TrendingDown size={12} className="text-[#4a90d9]" />
  return <Minus size={12} className="text-zinc-500" />
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-xs font-medium tabular-nums text-zinc-300">{value}</span>
      <span className="text-[9px] text-zinc-600">{label}</span>
    </div>
  )
}
