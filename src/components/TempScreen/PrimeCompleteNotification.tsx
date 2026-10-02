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
    <div role="status" className="flex items-center gap-2.5 rounded-ctl border border-ok-line px-3 py-2.5">
      <CheckCircle size={14} className="shrink-0 text-ok" />
      <p className="flex-1 text-[13px] text-ok">
        Priming complete — your pod is ready
      </p>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={handleDismiss}
        disabled={dismissMutation.isPending}
        className="flex size-8 cursor-pointer items-center justify-center rounded-ctl border-0 bg-transparent text-fg-2 hover:bg-active hover:text-fg disabled:opacity-45"
      >
        <X size={14} />
      </button>
    </div>
  )
}
