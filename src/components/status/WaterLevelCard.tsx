'use client'

import { useState, useCallback } from 'react'
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
                  {trend.changePercent > 0 ? '+' : ''}{trend.changePercent.toFixed(1)}% / 24h
                </span>
              )}
              {trend.direction === 'stable' && <span>Stable</span>}
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-zinc-600">No water level data</p>
      )}

      {/* Level bar */}
      {latest?.levelPercent != null && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              latest.levelPercent < 20 ? 'bg-red-400' :
              latest.levelPercent < 40 ? 'bg-amber-400' : 'bg-sky-400'
            }`}
            style={{ width: `${Math.min(latest.levelPercent, 100)}%` }}
          />
        </div>
      )}

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
