'use client'

import { useMemo } from 'react'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { BedTempFrame, BedTemp2Frame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { Cloud, Droplets, Thermometer, Sun } from 'lucide-react'

/**
 * Environment card showing per-side humidity and ambient temperature.
 * Combines live WebSocket sensor frames with tRPC-fetched historical data
 * from environment.getLatestBedTemp, environment.getSummary, and
 * environment.getLatestAmbientLight for a complete environment view.
 *
 * Falls back to tRPC data when WebSocket hasn't sent frames yet.
 * Matches iOS BedSensorScreen envCard layout.
 */
export function EnvironmentCard() {
  const { unit, formatTemp, formatConverted, suffix } = useTemperatureUnit()

  // Live WebSocket frames
  const bedTemp = useSensorFrame('bedTemp')
  const bedTemp2 = useSensorFrame('bedTemp2')
  const liveFrame: BedTempFrame | BedTemp2Frame | undefined = bedTemp2 ?? bedTemp

  // tRPC fallback: latest bed temp reading from database
  const latestBedTemp = trpc.environment.getLatestBedTemp.useQuery(
    { unit },
    {
      refetchInterval: 30_000, // refresh every 30s
      staleTime: 15_000,
    },
  )

  // tRPC: environment summary (last 24 hours)
  const now = useMemo(() => new Date(), [])
  const twentyFourHoursAgo = useMemo(() => new Date(now.getTime() - 24 * 60 * 60 * 1000), [now])

  const summary = trpc.environment.getSummary.useQuery(
    { startDate: twentyFourHoursAgo, endDate: now, unit },
    {
      refetchInterval: 60_000, // refresh every minute
      staleTime: 30_000,
    },
  )

  // tRPC: latest ambient light
  const ambientLight = trpc.environment.getLatestAmbientLight.useQuery(
    {},
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )

  // Merge live + tRPC data: live WebSocket takes priority, tRPC as fallback.
  // formatHumidity returns '--' for missing values (truthy), so use nullish check.
  const liveHumidity = formatHumidity(liveFrame?.humidity)
  const leftHumidity = liveHumidity !== '--'
    ? liveHumidity
    : formatHumidityFromTRPC(latestBedTemp.data?.humidity)
  const leftAmbient = (liveFrame?.ambientTemp != null ? formatTemp(liveFrame.ambientTemp) : null)
    ?? (latestBedTemp.data?.ambientTemp != null ? formatConverted(latestBedTemp.data.ambientTemp) : '--')

  // Normalized frames combine left/right ambient+humidity into single values
  const rightHumidity: string | null = null
  const rightAmbient: string | null = null

  // Summary stats from tRPC (24h averages)
  const summaryData = summary.data?.bedTemp

  // Ambient light from tRPC
  const lightData = ambientLight.data

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-1.5">
        <Cloud size={10} className="text-sky-400" />
        <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Environment
        </h3>
        {latestBedTemp.data?.timestamp && !liveFrame && (
          <span className="text-[8px] text-zinc-600">
            (stored
            {' '}
            {formatRelativeTime(latestBedTemp.data.timestamp)}
            )
          </span>
        )}
      </div>

      {/* Live / Latest readings — 4-column grid */}
      <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 sm:gap-0">
        <EnvItem
          icon={<Droplets size={11} className="text-sky-400" />}
          value={leftHumidity}
          label="Humidity L"
        />
        <EnvItem
          icon={<Thermometer size={11} className="text-amber-400" />}
          value={leftAmbient}
          label="Ambient L"
        />
        <EnvItem
          icon={<Droplets size={11} className="text-sky-400" />}
          value={rightHumidity ?? leftHumidity}
          label="Humidity R"
        />
        <EnvItem
          icon={<Thermometer size={11} className="text-amber-400" />}
          value={rightAmbient ?? leftAmbient}
          label="Ambient R"
        />
      </div>

      {/* 24h Summary stats from tRPC */}
      {summaryData && (
        <div className="space-y-1.5">
          <div className="text-[8px] font-medium uppercase tracking-wider text-zinc-600">
            24h Summary
          </div>
          <div className="grid grid-cols-3 gap-1">
            <SummaryItem
              label="Avg Ambient"
              value={summaryData.avgAmbientTemp != null ? `${summaryData.avgAmbientTemp.toFixed(1)}${suffix}` : '--'}
            />
            <SummaryItem
              label="Avg Humidity"
              value={summaryData.avgHumidity != null ? `${summaryData.avgHumidity.toFixed(0)}%` : '--'}
            />
            <SummaryItem
              label="Ambient Range"
              value={
                summaryData.minAmbientTemp != null && summaryData.maxAmbientTemp != null
                  ? `${summaryData.minAmbientTemp.toFixed(0)}–${summaryData.maxAmbientTemp.toFixed(0)}${suffix}`
                  : '--'
              }
            />
          </div>
          <div className="grid grid-cols-2 gap-1">
            <SummaryItem
              label="Avg Bed L"
              value={summaryData.avgLeftCenterTemp != null ? `${summaryData.avgLeftCenterTemp.toFixed(1)}${suffix}` : '--'}
            />
            <SummaryItem
              label="Avg Bed R"
              value={summaryData.avgRightCenterTemp != null ? `${summaryData.avgRightCenterTemp.toFixed(1)}${suffix}` : '--'}
            />
          </div>
        </div>
      )}

      {/* Ambient light reading */}
      {lightData && (
        <div className="flex items-center gap-1.5 rounded-lg bg-zinc-800/50 px-2 py-1.5">
          <Sun size={11} className="text-yellow-400" />
          <span className="text-[10px] text-zinc-400">Ambient Light</span>
          <span className="ml-auto font-mono text-[10px] font-medium text-white">
            {typeof lightData.lux === 'number' ? `${lightData.lux.toFixed(0)} lux` : '--'}
          </span>
        </div>
      )}
    </div>
  )
}

function EnvItem({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode
  value: string
  label: string
}) {
  const isMissing = value === '--'

  return (
    <div className="flex flex-col items-center gap-0.5">
      <span className={isMissing ? 'opacity-30' : ''}>{icon}</span>
      <span className={`font-mono text-[10px] font-medium ${isMissing ? 'text-zinc-600' : 'text-white'}`}>
        {value}
      </span>
      <span className="text-[7px] text-zinc-600">{label}</span>
    </div>
  )
}

function SummaryItem({ label, value }: { label: string, value: string }) {
  return (
    <div className="flex flex-col items-center rounded-md bg-zinc-800/50 px-1.5 py-1">
      <span className="text-[7px] text-zinc-600">{label}</span>
      <span className="font-mono text-[9px] font-medium text-zinc-300">{value}</span>
    </div>
  )
}

function formatHumidity(value: unknown): string {
  if (typeof value !== 'number' || value <= 0 || value >= 100) return '--'
  return `${Math.round(value)}%`
}

function formatHumidityFromTRPC(value: unknown): string {
  if (typeof value !== 'number' || value <= 0 || value >= 100) return '--'
  return `${Math.round(value)}%`
}

// formatAmbientC/F removed — use useTemperatureUnit().formatTemp/formatConverted instead

function formatRelativeTime(timestamp: unknown): string {
  if (!timestamp) return ''
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp as string)
  const diffMs = Date.now() - date.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return `${Math.floor(diffHr / 24)}d ago`
}
