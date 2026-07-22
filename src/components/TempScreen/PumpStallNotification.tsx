'use client'

import { AlertTriangle, X } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { formatSetpointF, type TempUnit } from '@/src/lib/tempUtils'

interface PumpStallNotificationProps {
  side: 'left' | 'right'
  rpm: number
  /** unix seconds */
  trippedAt: number
  /** pump_alerts row id from the notice; 0 when the trip-time insert failed. */
  alertId?: number
  /** Setpoint Re-enable restores (notice.restore); null when the trip captured none. */
  restoreTargetF?: number | null
  unit?: TempUnit
  /** Called after either re-enable or dismiss settles so the parent can refetch. */
  onAction?: () => void
}

const formatTime = (unixSeconds: number): string => {
  const d = new Date(unixSeconds * 1000)
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

/**
 * Notification shown when the pump stall guard powered a side off.
 * Two actions:
 *   Re-enable — restores the pre-stall setpoint via the normal command
 *     path. If the pump is still bad, the guard re-trips on the next
 *     frame; the banner returns.
 *   Dismiss — clears the notification and re-arms stall protection; the
 *     side stays off until the user powers it back on, and any command
 *     path re-triggers the guard if the pump is still bad.
 */
export const PumpStallNotification = ({ side, rpm, trippedAt, alertId, restoreTargetF = null, unit = 'F', onAction }: PumpStallNotificationProps) => {
  const acknowledge = trpc.pumpAlerts.acknowledgeAndRestore.useMutation()
  const dismiss = trpc.pumpAlerts.dismissNotification.useMutation()
  // Correlate the mutation with the incident shown here — the server then
  // stamps exactly this row even across a restart. 0 means "no row".
  const alertRef = alertId || undefined

  // Guard-rejected HomeKit temp writes keep the requested value staged while
  // iOS shows the slider reverting; the next power-on heats to the staged
  // value (PR #670 F1). This card is the only surface that can re-enable the
  // side, so the mismatch is surfaced here. Polled, not streamed: the staged
  // value only moves on HomeKit writes and the card is rarely mounted.
  const { data: thermal } = trpc.health.thermal.useQuery({}, { refetchInterval: 15_000 })
  const sideHealth = thermal?.sides.find(s => s.side === side)
  const stagedF = sideHealth?.guardBlocked ? sideHealth.homekitStagedTargetF : null
  const stagedMismatch = stagedF != null && stagedF !== (restoreTargetF ?? null)

  // While either mutation is in flight, both actions stay disabled — the
  // two paths race for the same guard state and alert row.
  const busy = acknowledge.isPending || dismiss.isPending

  return (
    <div role="alert" className="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-950/30 p-3 sm:p-4">
      <AlertTriangle size={18} className="shrink-0 text-red-400" />
      <div className="flex-1 text-sm text-red-200">
        <p className="font-medium">
          {side === 'left' ? 'Left' : 'Right'}
          {' '}
          side powered off — pump stall detected
        </p>
        <p className="text-xs text-red-200/70">
          Pump RPM dropped to
          {' '}
          {rpm}
          {' '}
          at
          {' '}
          {formatTime(trippedAt)}
          . The side is off for safety. Re-enable to retry.
        </p>
        {stagedMismatch && (
          <p className="text-xs text-red-200/70">
            HomeKit has
            {' '}
            {formatSetpointF(stagedF, unit)}
            {' '}
            staged for the next power-on
            {restoreTargetF != null && ` — Re-enable restores ${formatSetpointF(restoreTargetF, unit)}`}
            .
          </p>
        )}
      </div>
      <button
        onClick={() => acknowledge.mutate({ side, alertId: alertRef }, { onSettled: onAction })}
        disabled={busy}
        className="rounded-full bg-red-500/20 px-3 py-2 text-xs text-red-100 transition-all hover:bg-red-500/30 active:scale-95 disabled:opacity-50"
      >
        Re-enable
      </button>
      <button
        onClick={() => dismiss.mutate({ side, alertId: alertRef }, { onSettled: onAction })}
        disabled={busy}
        aria-label="Dismiss pump stall notification"
        className="flex h-11 w-11 items-center justify-center rounded-full text-red-400/60 transition-all hover:text-red-300 active:scale-90 disabled:opacity-50"
      >
        <X size={16} />
      </button>
    </div>
  )
}
