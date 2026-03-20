'use client'

import { useEffect, useRef } from 'react'
import { useSensorFrame } from '@/src/hooks/useSensorStream'
import type { FrzTempFrame, FrzHealthFrame, FrzThermFrame } from '@/src/hooks/useSensorStream'
import { trpc } from '@/src/utils/trpc'
import { useTemperatureUnit } from '@/src/hooks/useTemperatureUnit'
import { Snowflake, Fan, Droplets, Gauge, AlertTriangle, CheckCircle, TrendingDown, TrendingUp, Minus, X } from 'lucide-react'

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
  const waterLevelLatest = trpc.waterLevel.getLatest.useQuery(
    {},
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )

  const waterLevelTrend = trpc.waterLevel.getTrend.useQuery(
    { hours: 24 },
    {
      refetchInterval: 60_000,
      staleTime: 30_000,
    },
  )

  const waterLevelAlerts = trpc.waterLevel.getAlerts.useQuery(
    {},
    {
      refetchInterval: 30_000,
      staleTime: 15_000,
    },
  )

  const dismissAlert = trpc.waterLevel.dismissAlert.useMutation({
    onSuccess: () => {
      void waterLevelAlerts.refetch()
    },
  })

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

  // Water level history for sparkline (last 24h)
  const waterLevelHistory = trpc.waterLevel.getHistory.useQuery(
    {
      startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
      endDate: new Date(),
      limit: 1440,
    },
    { refetchInterval: 60_000, staleTime: 30_000 },
  )

  // Water level from tRPC (not available via WebSocket frzHealth directly)
  const waterLevel = waterLevelLatest.data
  const trend = waterLevelTrend.data
  const alerts = waterLevelAlerts.data
  const history = waterLevelHistory.data as Array<{ timestamp: Date | string; level: string }> | undefined

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
        <div className="grid grid-cols-2 gap-2">
          {/* Water temperatures (live or stored fallback) */}
          {freezerTempData && (
            <>
              <MetricItem
                icon={<Snowflake size={16} className="text-sky-400" />}
                label="Left Water"
                value={freezerTempData.leftWater}
                subLabel="Water temp"
              />
              <MetricItem
                icon={<Snowflake size={16} className="text-teal-400" />}
                label="Right Water"
                value={freezerTempData.rightWater}
                subLabel="Water temp"
              />
              <MetricItem
                icon={<Gauge size={16} className="text-zinc-400" />}
                label="Ambient"
                value={freezerTempData.ambient}
              />
              <MetricItem
                icon={<Gauge size={16} className="text-orange-400" />}
                label="Heatsink"
                value={freezerTempData.heatsink}
              />
            </>
          )}

          {/* Freezer health metrics (live only) */}
          {frzHealth && (
            <>
              <MetricItem
                icon={<Gauge size={16} className="text-purple-400" />}
                label="TEC Left"
                value={`${frzHealth.left.tecCurrent.toFixed(2)} A`}
                status={frzHealth.left.tecCurrent > 5 ? 'warn' : 'ok'}
              />
              <MetricItem
                icon={<Gauge size={16} className="text-purple-400" />}
                label="TEC Right"
                value={`${frzHealth.right.tecCurrent.toFixed(2)} A`}
                status={frzHealth.right.tecCurrent > 5 ? 'warn' : 'ok'}
              />
              <MetricItem
                icon={<Droplets size={16} className="text-blue-400" />}
                label="Pump Left"
                value={`${frzHealth.left.pumpRpm} RPM`}
                status={frzHealth.left.pumpRpm > 0 ? 'ok' : 'warn'}
              />
              <MetricItem
                icon={<Droplets size={16} className="text-blue-400" />}
                label="Pump Right"
                value={`${frzHealth.right.pumpRpm} RPM`}
                status={frzHealth.right.pumpRpm > 0 ? 'ok' : 'warn'}
              />
              <MetricItem
                icon={<Fan size={16} className="text-cyan-400" />}
                label="Fan"
                value={`${frzHealth.fan.rpm} RPM`}
                status={frzHealth.fan.rpm < 100 ? 'warn' : 'ok'}
              />
            </>
          )}

          {/* Thermal control status (live only) */}
          {frzTherm && (
            <>
              <MetricItem
                icon={<Gauge size={16} className="text-sky-400" />}
                label="Therm Left"
                value={typeof frzTherm.left === 'number' ? frzTherm.left.toFixed(1) : '--'}
                subLabel="Control signal"
              />
              <MetricItem
                icon={<Gauge size={16} className="text-teal-400" />}
                label="Therm Right"
                value={typeof frzTherm.right === 'number' ? frzTherm.right.toFixed(1) : '--'}
                subLabel="Control signal"
              />
            </>
          )}
        </div>
      )}

      {/* Water Level Section (tRPC) */}
      <WaterLevelSection
        waterLevel={waterLevel}
        trend={trend}
        history={history}
        alerts={alerts}
        onDismissAlert={(id) => dismissAlert.mutate({ id })}
        isDismissing={dismissAlert.isPending}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Water Level sub-components
// ---------------------------------------------------------------------------

interface WaterLevelSectionProps {
  waterLevel: { id: number; timestamp: Date; level: string } | null | undefined
  trend: {
    totalReadings: number
    okPercent: number
    lowPercent: number
    trend: 'stable' | 'declining' | 'rising' | 'unknown'
  } | undefined
  history: Array<{ timestamp: Date | string; level: string }> | undefined
  alerts: Array<{ id: number; level: string; createdAt: Date; dismissedAt: Date | null }> | undefined
  onDismissAlert: (id: number) => void
  isDismissing: boolean
}

function WaterLevelSection({ waterLevel, trend, history, alerts, onDismissAlert, isDismissing }: WaterLevelSectionProps) {
  const hasWaterData = waterLevel || trend

  if (!hasWaterData) return null

  const isLow = waterLevel?.level === 'low'
  const trendIcon = trend?.trend === 'declining'
    ? <TrendingDown size={10} className="text-red-400" />
    : trend?.trend === 'rising'
      ? <TrendingUp size={10} className="text-emerald-400" />
      : <Minus size={10} className="text-zinc-500" />

  return (
    <div className="space-y-2 pt-1">
      <div className="flex items-center gap-1.5">
        <Droplets size={10} className="text-blue-400" />
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Water Level
        </h4>
      </div>

      {/* Current status + trend */}
      <div className="flex items-center gap-2 rounded-lg bg-zinc-900 p-2.5">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
          {isLow ? (
            <AlertTriangle size={16} className="text-amber-400" />
          ) : (
            <CheckCircle size={16} className="text-emerald-400" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium text-zinc-500">Current Level</div>
          <div className={`text-sm font-semibold ${isLow ? 'text-amber-400' : 'text-emerald-400'}`}>
            {waterLevel?.level === 'ok' ? 'OK' : waterLevel?.level === 'low' ? 'Low' : '--'}
          </div>
          {waterLevel?.timestamp && (
            <div className="text-[9px] text-zinc-600">
              {formatWaterTimestamp(waterLevel.timestamp)}
            </div>
          )}
        </div>
        {trend && (
          <div className="flex flex-col items-end gap-0.5">
            <div className="flex items-center gap-1">
              {trendIcon}
              <span className="text-[9px] font-medium capitalize text-zinc-400">
                {trend.trend}
              </span>
            </div>
            <span className="text-[8px] text-zinc-600">
              24h: {trend.okPercent}% OK
            </span>
            {trend.totalReadings > 0 && (
              <span className="text-[7px] text-zinc-700">
                {trend.totalReadings} readings
              </span>
            )}
          </div>
        )}
      </div>

      {/* Water level sparkline (24h) */}
      {history && history.length > 1 && (
        <WaterSparkline data={history} />
      )}

      {/* Active alerts */}
      {alerts && alerts.length > 0 && (
        <div className="space-y-1">
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className="flex items-center gap-2 rounded-lg bg-amber-900/20 px-2.5 py-1.5"
            >
              <AlertTriangle size={12} className="shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <span className="text-[10px] font-medium text-amber-300">
                  Water level low
                </span>
                <span className="ml-1 text-[8px] text-zinc-500">
                  {formatWaterTimestamp(alert.createdAt)}
                </span>
              </div>
              <button
                onClick={() => onDismissAlert(alert.id)}
                disabled={isDismissing}
                className="shrink-0 rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300 active:bg-zinc-700 disabled:opacity-50"
                aria-label="Dismiss alert"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Canvas sparkline showing water level over time.
 * OK = green bar at top, Low = amber bar at bottom.
 * Each reading gets a thin vertical bar at its time position.
 */
function WaterSparkline({ data }: { data: Array<{ timestamp: Date | string; level: string }> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || data.length < 2) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const W = rect.width
    const H = rect.height

    ctx.clearRect(0, 0, W, H)

    // Background
    ctx.fillStyle = 'rgba(0,0,0,0.3)'
    ctx.beginPath()
    ctx.roundRect(0, 0, W, H, 4)
    ctx.fill()

    // Time range
    const toMs = (ts: Date | string) => new Date(ts).getTime()
    const sorted = [...data].sort((a, b) => toMs(a.timestamp) - toMs(b.timestamp))

    const tMin = toMs(sorted[0].timestamp)
    const tMax = toMs(sorted[sorted.length - 1].timestamp)
    const tRange = tMax - tMin || 1

    // Draw bars
    const barW = Math.max(1, W / sorted.length * 0.8)
    for (const reading of sorted) {
      const t = toMs(reading.timestamp)
      const x = ((t - tMin) / tRange) * (W - barW)
      const isOk = reading.level === 'ok'

      ctx.fillStyle = isOk ? 'rgba(52, 211, 153, 0.6)' : 'rgba(251, 191, 36, 0.7)'
      // OK bars fill top half, Low bars fill bottom half
      if (isOk) {
        ctx.fillRect(x, 1, barW, H / 2 - 1)
      } else {
        ctx.fillRect(x, H / 2, barW, H / 2 - 1)
      }
    }

    // Center line
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'
    ctx.lineWidth = 0.5
    ctx.beginPath()
    ctx.moveTo(0, H / 2)
    ctx.lineTo(W, H / 2)
    ctx.stroke()

    // Time labels
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.font = '7px monospace'
    const startLabel = new Date(tMin).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    const endLabel = new Date(tMax).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    ctx.fillText(startLabel, 2, H - 1)
    ctx.textAlign = 'right'
    ctx.fillText(endLabel, W - 2, H - 1)
  }, [data])

  return (
    <div className="space-y-0.5">
      <canvas ref={canvasRef} className="w-full rounded" style={{ height: 28 }} />
      <div className="flex justify-between text-[7px] text-zinc-600">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-sm bg-emerald-400/60" /> OK
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-sm bg-amber-400/70" /> Low
        </span>
      </div>
    </div>
  )
}

function formatWaterTimestamp(timestamp: Date | string): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
