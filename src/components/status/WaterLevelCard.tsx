'use client'

import { useState, useCallback, useMemo } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Droplets, Play, X, AlertTriangle, TrendingDown, TrendingUp, Minus, Loader2 } from 'lucide-react'

function trendIcon(direction: string) {
  if (direction === 'falling') return <TrendingDown size={12} className="text-amber-400" />
  if (direction === 'rising') return <TrendingUp size={12} className="text-emerald-400" />
  return <Minus size={12} className="text-zinc-500" />
}

/**
 * WaterLevelCard — water level status, trends, alerts, and priming controls.
 * Shown on the Status screen.
 *
 * Wires into:
 * - waterLevel.getLatest → current level
 * - waterLevel.getTrend → directional trend
 * - waterLevel.getAlerts → active alerts
 * - waterLevel.dismissAlert → dismiss alerts
 * - device.startPriming → trigger prime cycle
 * - device.dismissPrimeNotification → dismiss prime complete notification
 */
export function WaterLevelCard() {
  const utils = trpc.useUtils()
  const [showPrimeConfirm, setShowPrimeConfirm] = useState(false)

  const { data: latest, isLoading } = trpc.waterLevel.getLatest.useQuery(
    {},
    { refetchInterval: 30_000 },
  )

  const { data: trend } = trpc.waterLevel.getTrend.useQuery(
    { hours: 24 },
    { refetchInterval: 60_000 },
  )

  // Last 7 days of readings for the trend chart
  const { data: history } = trpc.waterLevel.getHistory.useQuery(
    {
      startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      limit: 10000,
    },
    { refetchInterval: 60_000 },
  )

  const { data: alerts } = trpc.waterLevel.getAlerts.useQuery(
    {},
    { refetchInterval: 30_000 },
  )

  const dismissAlertMutation = trpc.waterLevel.dismissAlert.useMutation({
    onSuccess: () => utils.waterLevel.getAlerts.invalidate(),
  })

  const startPrimeMutation = trpc.device.startPriming.useMutation({
    onSuccess: () => {
      setShowPrimeConfirm(false)
      utils.device.getStatus.invalidate()
    },
  })

  const dismissPrimeMutation = trpc.device.dismissPrimeNotification.useMutation({
    onSuccess: () => utils.device.getStatus.invalidate(),
  })

  const handleDismissAlert = useCallback((id: number) => {
    dismissAlertMutation.mutate({ id })
  }, [dismissAlertMutation])

  const handleStartPrime = () => {
    startPrimeMutation.mutate({})
  }

  const activeAlerts = alerts ?? []

  return (
    <div className="rounded-2xl bg-zinc-900/80 p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Droplets size={16} className="text-sky-400" />
          <span className="text-sm font-medium text-white">Water Level</span>
        </div>
        {trend && trendIcon(trend.direction)}
      </div>

      {/* Current level */}
      {isLoading ? (
        <div className="flex h-12 items-center justify-center">
          <Loader2 size={16} className="animate-spin text-zinc-600" />
        </div>
      ) : latest ? (
        <div className="flex items-end gap-3">
          <div>
            <p className="text-2xl font-bold tabular-nums text-white">
              {typeof latest.levelPercent === 'number'
                ? `${Math.round(latest.levelPercent)}%`
                : '--'}
            </p>
            <p className="text-[10px] text-zinc-500">
              {new Date(latest.timestamp).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          </div>
          {trend && (
            <div className="mb-1 text-xs text-zinc-500">
              {trend.direction !== 'stable' && (
                <span>
                  {(trend.changePercent ?? 0) > 0 ? '+' : ''}{(trend.changePercent ?? 0).toFixed(1)}% / 24h
                </span>
              )}
              {trend.direction === 'stable' && <span>Stable</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-zinc-600">No water level data</p>
      )}

      {/* 7-day trend chart */}
      <WaterLevelChart history={history} />

      {/* Active alerts */}
      {activeAlerts.length > 0 && (
        <div className="space-y-1.5">
          {activeAlerts.map((alert: { id: number; alertType: string; message: string }) => (
            <div
              key={alert.id}
              className="flex items-center gap-2 rounded-lg bg-amber-900/20 px-3 py-2"
            >
              <AlertTriangle size={12} className="shrink-0 text-amber-400" />
              <span className="flex-1 text-[11px] text-amber-300">{alert.message}</span>
              <button
                onClick={() => handleDismissAlert(alert.id)}
                disabled={dismissAlertMutation.isPending}
                className="shrink-0 rounded p-1 text-zinc-500 active:bg-zinc-700"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Prime controls */}
      {!showPrimeConfirm ? (
        <button
          onClick={() => setShowPrimeConfirm(true)}
          className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-zinc-800 px-4 py-2.5 text-xs font-medium text-zinc-400 transition-colors active:bg-zinc-800"
        >
          <Play size={14} />
          Start Prime
        </button>
      ) : (
        <div className="space-y-2">
          <p className="text-[11px] text-amber-400">
            Priming circulates water through the system. This takes ~5 minutes.
          </p>
          <div className="flex gap-2">
            <button
              onClick={handleStartPrime}
              disabled={startPrimeMutation.isPending}
              className="flex flex-1 min-h-[44px] items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-xs font-medium text-white active:bg-sky-700 disabled:opacity-50"
            >
              {startPrimeMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Play size={14} />
              )}
              Confirm Prime
            </button>
            <button
              onClick={() => setShowPrimeConfirm(false)}
              className="rounded-xl border border-zinc-800 px-4 py-2.5 text-xs font-medium text-zinc-400 active:bg-zinc-800"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Prime error */}
      {startPrimeMutation.isError && (
        <p className="text-[10px] text-red-400">
          {startPrimeMutation.error?.message ?? 'Failed to start prime'}
        </p>
      )}
    </div>
  )
}

// SVG sparkline of water level over time — shows leak trends
function WaterLevelChart({ history }: { history?: { timestamp: Date; level: string }[] }) {
  const points = useMemo(() => {
    if (!history || history.length < 2) return null
    // History is DESC, reverse to chronological
    const sorted = [...history].reverse()
    const values = sorted.map(r => ({
      ts: new Date(r.timestamp).getTime(),
      level: r.level === 'low' ? 30 : 80,
    }))
    // Downsample to ~200 points for performance
    const step = Math.max(1, Math.floor(values.length / 200))
    return values.filter((_, i) => i % step === 0 || i === values.length - 1)
  }, [history])

  if (!points || points.length < 2) return null

  const W = 300
  const H = 48
  const PAD = 2
  const minTs = points[0].ts
  const maxTs = points[points.length - 1].ts
  const tsRange = maxTs - minTs || 1

  const toX = (ts: number) => PAD + ((ts - minTs) / tsRange) * (W - PAD * 2)
  const toY = (level: number) => H - PAD - ((level - 10) / 90) * (H - PAD * 2)

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.ts).toFixed(1)},${toY(p.level).toFixed(1)}`)
    .join(' ')

  // Area fill under the line
  const areaD = `${pathD} L${toX(points[points.length - 1].ts).toFixed(1)},${H} L${toX(points[0].ts).toFixed(1)},${H} Z`

  // Color based on latest level
  const lastLevel = points[points.length - 1].level
  const color = lastLevel <= 30 ? '#f87171' : lastLevel <= 50 ? '#fbbf24' : '#38bdf8'

  // Day labels
  const dayLabels = useMemo(() => {
    const labels: { x: number; label: string }[] = []
    const seen = new Set<string>()
    for (const p of points) {
      const d = new Date(p.ts)
      const day = d.toLocaleDateString('en-US', { weekday: 'short' })
      if (!seen.has(day)) {
        seen.add(day)
        labels.push({ x: toX(p.ts), label: day })
      }
    }
    return labels
  }, [points])

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full h-auto" preserveAspectRatio="none">
        <defs>
          <linearGradient id="waterFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#waterFill)" />
        <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        {dayLabels.map((d, i) => (
          <text key={i} x={d.x} y={H + 11} fill="#666" fontSize="8" textAnchor="start">
            {d.label}
          </text>
        ))}
      </svg>
    </div>
  )
}
