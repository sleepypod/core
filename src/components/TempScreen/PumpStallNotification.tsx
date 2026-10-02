'use client'

import { AlertTriangle, X } from 'lucide-react'
import { Button } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'

interface PumpStallNotificationProps {
  side: 'left' | 'right'
  rpm: number
  /** unix seconds */
  trippedAt: number
  /** pump_alerts row id from the notice; 0 when the trip-time insert failed. */
  alertId?: number
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
export const PumpStallNotification = ({ side, rpm, trippedAt, alertId, onAction }: PumpStallNotificationProps) => {
  const acknowledge = trpc.pumpAlerts.acknowledgeAndRestore.useMutation()
  const dismiss = trpc.pumpAlerts.dismissNotification.useMutation()
  // Correlate the mutation with the incident shown here — the server then
  // stamps exactly this row even across a restart. 0 means "no row".
  const alertRef = alertId || undefined

  // While either mutation is in flight, both actions stay disabled — the
  // two paths race for the same guard state and alert row.
  const busy = acknowledge.isPending || dismiss.isPending

  return (
    <div role="alert" className="flex flex-wrap items-center gap-2.5 rounded-ctl border border-danger-line px-3 py-2.5">
      <AlertTriangle size={14} className="shrink-0 text-danger" />
      <div className="min-w-0 flex-1 text-[13px]">
        <p className="text-danger">
          {side === 'left' ? 'Left' : 'Right'}
          {' '}
          side powered off — pump stall detected
        </p>
        <p className="text-xs text-fg-2">
          Pump RPM dropped to
          {' '}
          <span className="font-mono">{rpm}</span>
          {' '}
          at
          {' '}
          <span className="font-mono">{formatTime(trippedAt)}</span>
          . The side is off for safety. Re-enable to retry.
        </p>
      </div>
      <Button
        size="sm"
        variant="danger"
        onClick={() => acknowledge.mutate({ side, alertId: alertRef }, { onSettled: onAction })}
        disabled={busy}
      >
        Re-enable
      </Button>
      <button
        type="button"
        onClick={() => dismiss.mutate({ side, alertId: alertRef }, { onSettled: onAction })}
        disabled={busy}
        aria-label="Dismiss pump stall notification"
        className="flex size-8 cursor-pointer items-center justify-center rounded-ctl border-0 bg-transparent text-fg-2 hover:bg-active hover:text-fg disabled:opacity-45"
      >
        <X size={14} />
      </button>
    </div>
  )
}
