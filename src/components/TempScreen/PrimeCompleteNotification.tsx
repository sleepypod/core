'use client'

import { CheckCircle, X } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'

interface PrimeCompleteNotificationProps {
  /** Called after dismissal to refresh status */
  onDismiss?: () => void
}

/**
 * Notification shown when pod priming has completed.
 * Dismissible via device.dismissPrimeNotification mutation.
 */
export const PrimeCompleteNotification = ({ onDismiss }: PrimeCompleteNotificationProps) => {
  const dismissMutation = trpc.device.dismissPrimeNotification.useMutation()

  const handleDismiss = () => {
    dismissMutation.mutate(
      {},
      { onSettled: onDismiss },
    )
  }

  return (
    <div className="flex items-center gap-2 rounded-2xl border border-emerald-500/20 bg-emerald-950/30 p-3 sm:p-4">
      <CheckCircle size={18} className="shrink-0 text-emerald-400" />
      <p className="flex-1 text-sm text-emerald-200">
        Priming complete — your pod is ready
      </p>
      <button
        onClick={handleDismiss}
        disabled={dismissMutation.isPending}
        className="flex h-11 w-11 items-center justify-center rounded-full text-emerald-400/60 transition-all hover:text-emerald-300 active:scale-90 disabled:opacity-50"
      >
        <X size={16} />
      </button>
    </div>
  )
}
