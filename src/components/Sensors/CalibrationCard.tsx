'use client'

import { useState } from 'react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import { Activity, Thermometer, Fingerprint, RefreshCw, CheckCircle, XCircle, Clock, Loader2, ChevronDown, ChevronUp } from 'lucide-react'

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

const SENSOR_CONFIG: Record<SensorType, { label: string; icon: typeof Activity; color: string }> = {
  piezo: { label: 'Piezo', icon: Activity, color: 'text-violet-400' },
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

function SensorCalibrationRow({
  type,
  profile,
  onTrigger,
  isTriggeringType,
}: {
  type: SensorType
  profile: CalibrationProfile | null
  onTrigger: (type: SensorType) => void
  isTriggeringType: SensorType | null
}) {
  const config = SENSOR_CONFIG[type]
  const Icon = config.icon
  const isTriggering = isTriggeringType === type
  const isActive = profile?.status === 'running' || profile?.status === 'pending'

  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-zinc-900 p-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-800">
        <Icon size={16} className={config.color} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-zinc-300">{config.label}</span>
          {profile && statusIcon(profile.status)}
        </div>
        {profile ? (
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold tabular-nums ${qualityColor(profile.qualityScore)}`}>
              {qualityLabel(profile.qualityScore)}
            </span>
            {profile.samplesUsed !== null && (
              <span className="text-[10px] text-zinc-600">
                {profile.samplesUsed} samples
              </span>
            )}
            <span className="text-[10px] text-zinc-600">
              {formatDate(profile.createdAt)}
            </span>
          </div>
        ) : (
          <span className="text-[10px] text-zinc-600">No calibration</span>
        )}
        {profile?.errorMessage && (
          <p className="mt-0.5 text-[10px] text-red-400/80 line-clamp-2">{profile.errorMessage}</p>
        )}
      </div>
      <button
        onClick={() => onTrigger(type)}
        disabled={isTriggering || isActive}
        className="shrink-0 rounded-lg bg-zinc-800 px-2.5 py-1.5 text-[10px] font-semibold text-zinc-300 transition-colors active:bg-zinc-700 disabled:text-zinc-600 disabled:active:bg-zinc-800"
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
}

/**
 * CalibrationCard — displays calibration status per sensor type and
 * allows triggering individual or full calibration procedures.
 * Also shows vitals quality scores and calibration history.
 *
 * Wired to calibration tRPC router:
 * - calibration.getStatus
 * - calibration.triggerCalibration
 * - calibration.triggerFullCalibration
 * - calibration.getVitalsQuality
 * - calibration.getHistory
 */
export function CalibrationCard() {
  const { side } = useSide()
  const utils = trpc.useUtils()
  const [triggeringType, setTriggeringType] = useState<SensorType | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [showQuality, setShowQuality] = useState(false)

  // Calibration status for current side
  const { data: status, isLoading: statusLoading } = trpc.calibration.getStatus.useQuery(
    { side },
    { refetchInterval: 5000 } // Poll while calibration may be running
  )

  // Calibration history
  const { data: history } = trpc.calibration.getHistory.useQuery(
    { side, limit: 10 },
    { enabled: showHistory }
  )

  // Vitals quality scores
  const { data: vitalsQuality } = trpc.calibration.getVitalsQuality.useQuery(
    { side, limit: 20 },
    { enabled: showQuality }
  )

  // Mutations
  const triggerSingle = trpc.calibration.triggerCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
      setTriggeringType(null)
    },
    onError: () => setTriggeringType(null),
  })

  const triggerFull = trpc.calibration.triggerFullCalibration.useMutation({
    onSuccess: () => {
      utils.calibration.getStatus.invalidate({ side })
    },
  })

  const handleTrigger = (type: SensorType) => {
    setTriggeringType(type)
    triggerSingle.mutate({ side, sensorType: type })
  }

  const handleFullCalibration = () => {
    triggerFull.mutate({})
  }

  const isAnyActive = status && (
    status.piezo?.status === 'running' || status.piezo?.status === 'pending' ||
    status.capacitance?.status === 'running' || status.capacitance?.status === 'pending' ||
    status.temperature?.status === 'running' || status.temperature?.status === 'pending'
  )

  return (
    <div className="space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <RefreshCw size={10} className="text-zinc-500" />
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            Calibration
          </h3>
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium uppercase text-zinc-500">
            {side}
          </span>
        </div>
        <button
          onClick={handleFullCalibration}
          disabled={triggerFull.isPending || !!isAnyActive}
          className="rounded-lg bg-zinc-800 px-2.5 py-1 text-[10px] font-semibold text-zinc-300 transition-colors active:bg-zinc-700 disabled:text-zinc-600"
        >
          {triggerFull.isPending ? (
            <span className="flex items-center gap-1">
              <Loader2 size={10} className="animate-spin" />
              Queued
            </span>
          ) : (
            'Calibrate All'
          )}
        </button>
      </div>

      {/* Status feedback */}
      {(triggerSingle.data || triggerFull.data) && (
        <div className="rounded-lg bg-emerald-900/20 px-3 py-2 text-[10px] text-emerald-400">
          {triggerSingle.data?.message || triggerFull.data?.message}
        </div>
      )}
      {(triggerSingle.error || triggerFull.error) && (
        <div className="rounded-lg bg-red-900/20 px-3 py-2 text-[10px] text-red-400">
          {triggerSingle.error?.message || triggerFull.error?.message}
        </div>
      )}

      {/* Sensor calibration rows */}
      {statusLoading ? (
        <div className="flex h-24 items-center justify-center">
          <Loader2 size={18} className="animate-spin text-zinc-600" />
        </div>
      ) : (
        <div className="space-y-1.5">
          {(['piezo', 'capacitance', 'temperature'] as const).map((type) => (
            <SensorCalibrationRow
              key={type}
              type={type}
              profile={status?.[type] ?? null}
              onTrigger={handleTrigger}
              isTriggeringType={triggeringType}
            />
          ))}
        </div>
      )}

      {/* Vitals Quality expandable section */}
      <button
        onClick={() => setShowQuality(v => !v)}
        className="flex w-full items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-[10px] font-medium text-zinc-400 transition-colors active:bg-zinc-800"
      >
        <span>Vitals Quality</span>
        {showQuality ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {showQuality && (
        <div className="space-y-1">
          {!vitalsQuality || vitalsQuality.length === 0 ? (
            <p className="px-3 py-2 text-[10px] text-zinc-600">No vitals quality data</p>
          ) : (
            <div className="max-h-40 overflow-y-auto rounded-lg bg-zinc-900 p-2">
              <div className="space-y-1">
                {vitalsQuality.map((vq: { id: number; qualityScore: number; timestamp: Date; flags: Record<string, unknown> | null; hrRaw: number | null }) => (
                  <div key={vq.id} className="flex items-center justify-between text-[10px]">
                    <span className="text-zinc-500">{formatDate(vq.timestamp)}</span>
                    <div className="flex items-center gap-2">
                      {vq.hrRaw !== null && (
                        <span className="text-zinc-500">{vq.hrRaw.toFixed(0)} bpm</span>
                      )}
                      <span className={`font-semibold tabular-nums ${qualityColor(vq.qualityScore)}`}>
                        {qualityLabel(vq.qualityScore)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Calibration History expandable section */}
      <button
        onClick={() => setShowHistory(v => !v)}
        className="flex w-full items-center justify-between rounded-lg bg-zinc-900 px-3 py-2 text-[10px] font-medium text-zinc-400 transition-colors active:bg-zinc-800"
      >
        <span>Calibration History</span>
        {showHistory ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {showHistory && (
        <div className="space-y-1">
          {!history || history.length === 0 ? (
            <p className="px-3 py-2 text-[10px] text-zinc-600">No calibration history</p>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg bg-zinc-900 p-2">
              <div className="space-y-1.5">
                {history.map((run: { id: number; sensorType: string; status: string; qualityScore: number | null; durationMs: number | null; triggeredBy: string | null; createdAt: Date; errorMessage: string | null }) => {
                  const config = SENSOR_CONFIG[run.sensorType as SensorType]
                  return (
                    <div key={run.id} className="flex items-center gap-2 rounded-md bg-zinc-800/50 px-2 py-1.5">
                      {statusIcon(run.status)}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className={`text-[10px] font-medium ${config?.color ?? 'text-zinc-400'}`}>
                            {config?.label ?? run.sensorType}
                          </span>
                          {run.triggeredBy && (
                            <span className="text-[9px] text-zinc-600">{run.triggeredBy}</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-[9px] text-zinc-600">
                          <span>{formatDate(run.createdAt)}</span>
                          {run.durationMs !== null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
                          {run.qualityScore !== null && (
                            <span className={qualityColor(run.qualityScore)}>
                              {qualityLabel(run.qualityScore)}
                            </span>
                          )}
                        </div>
                        {run.errorMessage && (
                          <p className="text-[9px] text-red-400/80 line-clamp-1">{run.errorMessage}</p>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
