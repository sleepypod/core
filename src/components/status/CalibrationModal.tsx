'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { useSideNames } from '@/src/hooks/useSideNames'
import { X, RefreshCw, Bed, Thermometer, Fingerprint, CheckCircle, XCircle, Clock, Loader2 } from 'lucide-react'

type SensorType = 'piezo' | 'capacitance' | 'temperature'

interface CalibrationProfile {
  id: number
  side: string
  sensorType: string
  status: string
  qualityScore: number | null
  samplesUsed: number | null
  createdAt: Date
  expiresAt: Date | null
  errorMessage: string | null
}

const SENSOR_CONFIG: Record<SensorType, { label: string; icon: typeof Bed; color: string }> = {
  piezo: { label: 'Piezo', icon: Bed, color: 'text-violet-400' },
  capacitance: { label: 'Capacitance', icon: Fingerprint, color: 'text-cyan-400' },
  temperature: { label: 'Temperature', icon: Thermometer, color: 'text-orange-400' },
}

function statusIcon(status: string) {
  switch (status) {
    case 'completed': return <CheckCircle size={14} className="text-emerald-400" />
    case 'failed': return <XCircle size={14} className="text-red-400" />
    case 'running': return <Loader2 size={14} className="animate-spin text-amber-400" />
    case 'pending': return <Clock size={14} className="text-zinc-400" />
    default: return null
  }
}

function qualityColor(score: number | null): string {
  if (score === null) return 'text-zinc-500'
  if (score >= 0.8) return 'text-emerald-400'
  if (score >= 0.5) return 'text-amber-400'
  return 'text-red-400'
}

function qualityLabel(score: number | null): string {
  if (score === null) return '--'
  return `${(score * 100).toFixed(0)}%`
}

function formatDate(d: Date | null | undefined): string {
  if (!d) return '--'
  const date = new Date(d)
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) +
    ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * Calibration modal. Opens from the HealthCircle or status page.
 * Contains: per-sensor calibration status, trigger buttons, and full calibration.
 */
export function CalibrationModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { side } = useSide()
  const { sideName } = useSideNames()
  const utils = trpc.useUtils()
  const [triggeringType, setTriggeringType] = useState<SensorType | null>(null)

  const { data: status, isLoading: statusLoading } = trpc.calibration.getStatus.useQuery(
    { side },
    { refetchInterval: 5000, enabled: open },
  )

  const triggerSingle = trpc.calibration.triggerCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
      setTriggeringType(null)
    },
    onError: () => setTriggeringType(null),
  })

  const triggerFull = trpc.calibration.triggerFullCalibration.useMutation({
    onSuccess: () => utils.calibration.getStatus.invalidate({ side }),
  })

  const handleTrigger = (type: SensorType) => {
    setTriggeringType(type)
    triggerSingle.mutate({ side, sensorType: type })
  }

  const isAnyActive = status && (
    status.piezo?.status === 'running' || status.piezo?.status === 'pending' ||
    status.capacitance?.status === 'running' || status.capacitance?.status === 'pending' ||
    status.temperature?.status === 'running' || status.temperature?.status === 'pending'
  )

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
            <RefreshCw size={14} className="text-zinc-400" />
            <span className="text-sm font-medium text-zinc-300">Calibration</span>
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
              {sideName(side)}
            </span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-800 active:text-zinc-300">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-4">
          {/* Status feedback */}
          {(triggerSingle.data || triggerFull.data) && (
            <div className="rounded-lg bg-emerald-900/20 px-3 py-2 text-[11px] text-emerald-400">
              {triggerSingle.data?.message || triggerFull.data?.message}
            </div>
          )}
          {(triggerSingle.error || triggerFull.error) && (
            <div className="rounded-lg bg-red-900/20 px-3 py-2 text-[11px] text-red-400">
              {triggerSingle.error?.message || triggerFull.error?.message}
            </div>
          )}

          {/* Sensor rows */}
          {statusLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Loader2 size={18} className="animate-spin text-zinc-600" />
            </div>
          ) : (
            <div className="space-y-2">
              {(['piezo', 'capacitance', 'temperature'] as const).map((type) => {
                const config = SENSOR_CONFIG[type]
                const Icon = config.icon
                const profile = status?.[type] as CalibrationProfile | null | undefined
                const isTriggering = triggeringType === type
                const isActive = profile?.status === 'running' || profile?.status === 'pending'

                return (
                  <div key={type} className="flex items-center gap-2.5 rounded-xl bg-zinc-900 p-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
                      <Icon size={16} className={config.color} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-zinc-300">{config.label}</span>
                        {profile && statusIcon(profile.status)}
                      </div>
                      {profile ? (
                        <div className="flex items-center gap-2">
                          <span className={`text-xs font-semibold tabular-nums ${qualityColor(profile.qualityScore)}`}>
                            {qualityLabel(profile.qualityScore)}
                          </span>
                          {profile.samplesUsed !== null && (
                            <span className="text-[10px] text-zinc-600">{profile.samplesUsed} samples</span>
                          )}
                          <span className="text-[10px] text-zinc-600">{formatDate(profile.createdAt)}</span>
                        </div>
                      ) : (
                        <span className="text-[10px] text-zinc-600">No calibration</span>
                      )}
                      {profile?.errorMessage && (
                        <p className="mt-0.5 text-[10px] text-red-400/80 line-clamp-2">{profile.errorMessage}</p>
                      )}
                    </div>
                    <button
                      onClick={() => handleTrigger(type)}
                      disabled={isTriggering || isActive}
                      className="shrink-0 rounded-lg bg-zinc-800 px-3 py-2 text-[11px] font-semibold text-zinc-300 transition-colors active:bg-zinc-700 disabled:text-zinc-600"
                    >
                      {isTriggering ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : isActive ? (
                        profile?.status === 'running' ? 'Running...' : 'Pending'
                      ) : (
                        'Calibrate'
                      )}
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {/* Full calibration button */}
          <button
            onClick={() => triggerFull.mutate({})}
            disabled={triggerFull.isPending || !!isAnyActive}
            className="flex w-full min-h-[44px] items-center justify-center gap-2 rounded-xl border border-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-400 transition-colors active:bg-zinc-800 disabled:opacity-50"
          >
            {triggerFull.isPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Calibrate All Sensors
          </button>
        </div>
      </div>
    </div>
  )
}
