'use client'

import { useState, useCallback, useMemo } from 'react'
import { trpc } from '@/src/utils/trpc'
import { X, Droplets, Play, AlertTriangle, TrendingDown, TrendingUp, Minus, Loader2 } from 'lucide-react'

function trendIcon(trend: string) {
  if (trend === 'declining') return <TrendingDown size={14} className="text-amber-400" />
  if (trend === 'rising') return <TrendingUp size={14} className="text-emerald-400" />
  return <Minus size={14} className="text-zinc-500" />
}

/**
 * Water level + priming modal. Opens from the HealthCircle water status chip.
 * Contains: current level, 24h trend, 7-day chart, alerts, and prime controls.
 */
export function WaterModal({ open, onClose }: { open: boolean, onClose: () => void }) {
  const utils = trpc.useUtils()
  const [showPrimeConfirm, setShowPrimeConfirm] = useState(false)

  const { data: latest, isLoading } = trpc.waterLevel.getLatest.useQuery(
    {},
    { refetchInterval: 30_000, enabled: open },
  )

  const { data: trend } = trpc.waterLevel.getTrend.useQuery(
    { hours: 24 },
    { refetchInterval: 60_000, enabled: open },
  )

  const { data: history } = trpc.waterLevel.getHistory.useQuery(
    {
      // eslint-disable-next-line react-hooks/purity
      startDate: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      limit: 10000,
    },
    { refetchInterval: 60_000, enabled: open },
  )

  const { data: alerts } = trpc.waterLevel.getAlerts.useQuery(
    {},
    { refetchInterval: 30_000, enabled: open },
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

  const handleDismissAlert = useCallback((id: number) => {
    dismissAlertMutation.mutate({ id })
  }, [dismissAlertMutation])

  const handleStartPrime = () => {
    startPrimeMutation.mutate({})
  }

  const activeAlerts = alerts ?? []

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex flex-col">
      <div className="flex-1 bg-black/60" onClick={onClose} />
      <div className="flex max-h-[80dvh] flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950">
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="h-1 w-8 rounded-full bg-zinc-700" />
        </div>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pb-3">
          <div className="flex items-center gap-2">
            <Droplets size={16} className="text-sky-400" />
            <span className="text-sm font-medium text-zinc-300">Water & Priming</span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 active:text-zinc-300">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-4">
          {/* Current level */}
          {isLoading
            ? (
                <div className="flex h-16 items-center justify-center">
                  <Loader2 size={18} className="animate-spin text-zinc-600" />
                </div>
              )
            : latest
              ? (
                  <div className="flex items-end gap-3">
                    <div>
                      <p className="text-3xl font-bold tabular-nums text-white">
                        {latest.level === 'ok' ? 'OK' : 'Low'}
                      </p>
                      <p className="text-[11px] text-zinc-500">
                        {new Date(latest.timestamp).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </p>
                    </div>
                    {trend && (
                      <div className="mb-1.5 flex items-center gap-1.5">
                        {trendIcon(trend.trend)}
                        <span className="text-xs text-zinc-500">
                          {trend.trend === 'stable' && 'Stable'}
                          {trend.trend === 'declining' && `Declining (${trend.lowPercent}% low)`}
                          {trend.trend === 'rising' && 'Rising'}
                          {trend.trend === 'unknown' && 'Insufficient data'}
                        </span>
                      </div>
                    )}
                  </div>
                )
              : (
                  <p className="text-xs text-zinc-600">No water level data</p>
                )}

          {/* 7-day chart */}
          <WaterLevelChart history={history} />

          {/* Active alerts */}
          {activeAlerts.length > 0 && (
            <div className="space-y-1.5">
              {activeAlerts.map(alert => (
                <div key={alert.id} className="flex items-center gap-2 rounded-lg bg-amber-900/20 px-3 py-2">
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
          {!showPrimeConfirm
            ? (
                <button
                  onClick={() => setShowPrimeConfirm(true)}
                  className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-400 transition-colors active:bg-zinc-800"
                >
                  <Play size={16} />
                  Start Prime
                </button>
              )
            : (
                <div className="space-y-2">
                  <p className="text-xs text-amber-400">
                    Priming circulates water through the system. This takes ~5 minutes.
                  </p>
                  <div className="flex gap-2">
                    <button
                      onClick={handleStartPrime}
                      disabled={startPrimeMutation.isPending}
                      className="flex flex-1 min-h-[44px] items-center justify-center gap-2 rounded-xl bg-sky-600 px-4 py-2.5 text-sm font-medium text-white active:bg-sky-700 disabled:opacity-50"
                    >
                      {startPrimeMutation.isPending
                        ? (
                            <Loader2 size={14} className="animate-spin" />
                          )
                        : (
                            <Play size={14} />
                          )}
                      Confirm Prime
                    </button>
                    <button
                      onClick={() => setShowPrimeConfirm(false)}
                      className="rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-400 active:bg-zinc-800"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

          {startPrimeMutation.isError && (
            <p className="text-[10px] text-red-400">
              {startPrimeMutation.error?.message ?? 'Failed to start prime'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function WaterLevelChart({ history }: { history?: { timestamp: Date, level: string }[] }) {
  const points = useMemo(() => {
    if (!history || history.length < 2) return null
    const sorted = [...history].reverse()
    const values = sorted.map(r => ({
      ts: new Date(r.timestamp).getTime(),
      level: r.level === 'low' ? 30 : 80,
    }))
    const step = Math.max(1, Math.floor(values.length / 200))
    return values.filter((_, i) => i % step === 0 || i === values.length - 1)
  }, [history])

  const W = 300
  const H = 48
  const PAD = 2

  // Day labels — must be called before early return (rules-of-hooks)
  const dayLabels = useMemo(() => {
    if (!points || points.length < 2) return []
    const minTs = points[0].ts
    const maxTs = points[points.length - 1].ts
    const tsRange = maxTs - minTs || 1
    const toX = (ts: number) => PAD + ((ts - minTs) / tsRange) * (W - PAD * 2)

    const labels: { x: number, label: string }[] = []
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
  }, [points, W, PAD])

  if (!points || points.length < 2) return null

  const minTs = points[0].ts
  const maxTs = points[points.length - 1].ts
  const tsRange = maxTs - minTs || 1

  const toX = (ts: number) => PAD + ((ts - minTs) / tsRange) * (W - PAD * 2)
  const toY = (level: number) => H - PAD - ((level - 10) / 90) * (H - PAD * 2)

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${toX(p.ts).toFixed(1)},${toY(p.level).toFixed(1)}`)
    .join(' ')

  const areaD = `${pathD} L${toX(points[points.length - 1].ts).toFixed(1)},${H} L${toX(points[0].ts).toFixed(1)},${H} Z`

  const lastLevel = points[points.length - 1].level
  const color = lastLevel <= 30 ? '#f87171' : lastLevel <= 50 ? '#fbbf24' : '#38bdf8'

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full h-auto" preserveAspectRatio="none">
        <defs>
          <linearGradient id="waterModalFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaD} fill="url(#waterModalFill)" />
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
