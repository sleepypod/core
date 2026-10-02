'use client'

import { cn } from '@/lib/utils'
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react'

interface SchedulerConfirmationProps {
  message: string | null
  isLoading?: boolean
  variant?: 'success' | 'error' | 'info'
}

/**
 * Fixed snackbar at the top of the viewport.
 * Slides in when a message is present, auto-dismisses via parent timer.
 */
export function SchedulerConfirmation({
  message,
  isLoading = false,
  variant = 'success',
}: SchedulerConfirmationProps) {
  const visible = !!message || isLoading

  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center transition-transform duration-150 ease-standard',
        visible ? 'translate-y-0' : '-translate-y-full',
      )}
    >
      <div
        className={cn(
          'mx-4 mt-3 flex items-center gap-2 rounded-ctl border bg-surface px-3.5 py-2.5 text-[13px]',
          variant === 'success' && 'border-ok-line text-ok',
          variant === 'error' && 'border-danger-line text-danger',
          variant === 'info' && 'border-line-2 text-fg',
        )}
        role="status"
        aria-live="polite"
      >
        {isLoading
          ? <Loader2 size={14} className="animate-spin" />
          : variant === 'error'
            ? <AlertCircle size={14} />
            : <CheckCircle size={14} />}
        <span>{isLoading ? 'Saving…' : message}</span>
      </div>
    </div>
  )
}
