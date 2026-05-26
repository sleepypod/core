'use client'

import { AlertTriangle, X } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'

interface PumpStallNotificationProps {
  side: 'left' | 'right'
  rpm: number
  /** unix seconds */
  trippedAt: number
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
 *   Dismiss — clears the notification only. Side stays off.
 */
export const PumpStallNotification = ({ side, rpm, trippedAt, onAction }: PumpStallNotificationProps) => {
  const acknowledge = trpc.pumpAlerts.acknowledgeAndRestore.useMutation()
  const dismiss = trpc.pumpAlerts.dismissNotification.useMutation()

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-red-500/20 bg-red-950/30 p-3 sm:p-4">
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
      </div>
      <button
        onClick={() => acknowledge.mutate({ side }, { onSettled: onAction })}
        disabled={acknowledge.isPending}
        className="rounded-full bg-red-500/20 px-3 py-2 text-xs text-red-100 transition-all hover:bg-red-500/30 active:scale-95 disabled:opacity-50"
      >
        Re-enable
      </button>
      <button
        onClick={() => dismiss.mutate({ side }, { onSettled: onAction })}
        disabled={dismiss.isPending}
        className="flex h-11 w-11 items-center justify-center rounded-full text-red-400/60 transition-all hover:text-red-300 active:scale-90 disabled:opacity-50"
      >
        <X size={16} />
      </button>
    </div>
  )
}
