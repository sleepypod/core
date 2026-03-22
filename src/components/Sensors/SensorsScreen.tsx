'use client'

import { useCallback, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { Droplets, Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { useSensorStream } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { PullToRefresh } from '@/src/components/PullToRefresh/PullToRefresh'
import { TimeRangeSelector, getDateRangeFromTimeRange, type TimeRange } from '@/src/components/Environment/TimeRangeSelector'
import { BedTempChart } from '@/src/components/Environment/BedTempChart'
import { HumidityChart } from '@/src/components/Environment/HumidityChart'
import { ConnectionStatusBar } from './ConnectionStatusBar'
import { PresenceCard } from './PresenceCard'
import { BedTempMatrix } from './BedTempMatrix'
import { FreezerHealthCard } from './FreezerHealthCard'
import { PiezoWaveform } from './PiezoWaveform'

const DataPipeline = dynamic(() => import('./DataPipeline').then(m => ({ default: m.DataPipeline })), {
  ssr: false,
  loading: () => <div className="flex h-[400px] items-center justify-center text-xs text-zinc-600">Loading pipeline...</div>,
})

/**
 * Main Sensors screen composition.
 * Connects to the WebSocket sensor stream and renders all live sensor
 * data panels: connection bar, sensor matrix (bed temp), presence with
 * zone activity, piezo waveform, bed temp trend (recharts), humidity (recharts),
 * movement, and system health.
 *
 * Pull-to-refresh reconnects the WebSocket stream.
 * Matches iOS BedSensorScreen layout and functionality.
 */
export function SensorsScreen() {
  const [streamEnabled, setStreamEnabled] = useState(true)
  const [timeRange, setTimeRange] = useState<TimeRange>('6h')

  // Connect to the sensor stream
  const stream = useSensorStream({ enabled: streamEnabled })

  const dateRange = useMemo(
    () => getDateRangeFromTimeRange(timeRange),
    [timeRange],
  )

  const limit = useMemo(() => {
    const hours = parseInt(timeRange)
    return Math.min(hours * 60, 1440)
  }, [timeRange])

  // Fetch historical bed temp for trend chart + humidity chart
  const bedTempQuery = trpc.environment.getBedTemp.useQuery(
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      limit,
      unit: 'F',
    },
    {
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  )

  // Fetch environment summary for stats
  const summaryQuery = trpc.environment.getSummary.useQuery(
    {
      startDate: dateRange.startDate,
      endDate: dateRange.endDate,
      unit: 'F',
    },
    { staleTime: 60_000 },
  )

  const summary = summaryQuery.data?.bedTemp

  // Determine ambient trend
  const latestQuery = trpc.environment.getLatestBedTemp.useQuery(
    { unit: 'F' },
    { refetchInterval: 30_000, staleTime: 15_000 },
  )
  const latest = latestQuery.data

  const ambientTrend = useMemo(() => {
    if (!summary?.minAmbientTemp || !summary?.maxAmbientTemp) return null
    const range = summary.maxAmbientTemp - summary.minAmbientTemp
    if (range < 1) return 'stable'
    if (latest?.ambientTemp != null) {
      const mid = (summary.minAmbientTemp + summary.maxAmbientTemp) / 2
      return latest.ambientTemp > mid ? 'warming' : 'cooling'
    }
    return null
  }, [summary, latest])

  /** Pull-to-refresh: toggle stream off/on to force reconnect. */
  const handleRefresh = useCallback(async () => {
    setStreamEnabled(false)
    await new Promise(resolve => setTimeout(resolve, 300))
    setStreamEnabled(true)
  }, [])

  return (
    <PullToRefresh onRefresh={handleRefresh} enabled={streamEnabled}>
    <div className="-mt-1 space-y-3 pb-4">
      {/* Connection status bar + stream toggle */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <ConnectionStatusBar
            status={stream.status}
            fps={stream.fps}
            lastError={stream.lastError}
            subscribedSensors={stream.subscribedSensors}
            lastFrameTime={stream.lastFrameTime}
          />
        </div>
        <button
          onClick={() => setStreamEnabled(v => !v)}
          className={`shrink-0 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
            streamEnabled
              ? 'bg-red-900/30 text-red-400 active:bg-red-900/50'
              : 'bg-emerald-900/30 text-emerald-400 active:bg-emerald-900/50'
          }`}
        >
          {streamEnabled ? 'Stop' : 'Start'}
        </button>
      </div>

      {/* Paused state */}
      {!streamEnabled && (
        <div className="flex h-32 items-center justify-center rounded-2xl bg-zinc-900">
          <div className="text-center">
            <p className="text-sm text-zinc-400">Stream paused</p>
            <p className="text-xs text-zinc-600">Tap Start to resume live data</p>
          </div>
        </div>
      )}

      {streamEnabled && (
        <>
          {/* Data Pipeline — static DAG + live canvas timeline */}
          <SensorCard>
            <DataPipeline />
          </SensorCard>

          {/* Piezo Waveform — real-time BCG signal */}
          <SensorCard>
            <PiezoWaveform />
          </SensorCard>

          {/* Bed Presence — capacitive sensing with zone activity */}
          <SensorCard>
            <PresenceCard />
          </SensorCard>

          {/* Sensor Matrix — Bed Temperature Grid */}
          <SensorCard>
            <BedTempMatrix />
          </SensorCard>

          {/* Bed Temperature Trend — recharts LineChart (from biometrics) */}
          <SensorCard>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <TrendIcon trend={ambientTrend} />
                  <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                    Bed Temperature Trend
                  </h3>
                </div>
                <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
              </div>

              {bedTempQuery.isLoading ? (
                <div className="flex h-[200px] items-center justify-center">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
                </div>
              ) : bedTempQuery.isError ? (
                <div className="flex h-[200px] items-center justify-center text-sm text-red-400">
                  Failed to load temperature data
                </div>
              ) : (
                <BedTempChart
                  data={bedTempQuery.data ?? []}
                  unit="F"
                  showAmbient
                  highlightSide="both"
                />
              )}

              {/* Summary stats */}
              {summary && (
                <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 border-t border-zinc-800 pt-2">
                  <SummaryItem
                    label="Avg Bed L"
                    value={summary.avgLeftCenterTemp != null ? `${Math.round(summary.avgLeftCenterTemp)}°` : '--'}
                  />
                  <SummaryItem
                    label="Avg Bed R"
                    value={summary.avgRightCenterTemp != null ? `${Math.round(summary.avgRightCenterTemp)}°` : '--'}
                  />
                  <SummaryItem
                    label="Avg Ambient"
                    value={summary.avgAmbientTemp != null ? `${Math.round(summary.avgAmbientTemp)}°` : '--'}
                  />
                  <SummaryItem
                    label="Humidity"
                    value={summary.avgHumidity != null ? `${Math.round(summary.avgHumidity)}%` : '--'}
                  />
                </div>
              )}
            </div>
          </SensorCard>

          {/* Humidity Trend — recharts AreaChart (from biometrics) */}
          <SensorCard>
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Droplets size={10} className="text-[#4a90d9]" />
                <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  Humidity
                </h3>
              </div>
              {bedTempQuery.isLoading ? (
                <div className="flex h-[140px] items-center justify-center">
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-700 border-t-zinc-400" />
                </div>
              ) : (
                <HumidityChart data={bedTempQuery.data ?? []} />
              )}
            </div>
          </SensorCard>

          {/* System — freezer thermal health */}
          <SensorCard>
            <FreezerHealthCard />
          </SensorCard>
        </>
      )}
    </div>
    </PullToRefresh>
  )
}

/** Consistent card wrapper matching iOS cardStyle(). */
function SensorCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-zinc-800/50 bg-zinc-900 p-2 sm:p-3">
      {children}
    </section>
  )
}

function TrendIcon({ trend }: { trend: string | null }) {
  if (trend === 'warming') return <TrendingUp size={10} className="text-[#d4a84a]" />
  if (trend === 'cooling') return <TrendingDown size={10} className="text-[#4a90d9]" />
  return <Minus size={10} className="text-zinc-500" />
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center">
      <span className="text-xs font-medium tabular-nums text-zinc-300">{value}</span>
      <span className="text-[9px] text-zinc-600">{label}</span>
    </div>
  )
}

