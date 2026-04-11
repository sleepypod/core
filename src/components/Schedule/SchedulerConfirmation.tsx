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
        'fixed left-0 right-0 top-0 z-50 flex justify-center transition-transform duration-300',
        visible ? 'translate-y-0' : '-translate-y-full',
      )}
    >
      <div
        className={cn(
          'mx-4 mt-3 flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm shadow-lg backdrop-blur-sm',
          variant === 'success' && 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/20',
          variant === 'error' && 'bg-red-500/20 text-red-400 border border-red-500/20',
          variant === 'info' && 'bg-sky-500/20 text-sky-400 border border-sky-500/20',
        )}
        role="status"
        aria-live="polite"
      >
        {isLoading
          ? <Loader2 size={16} className="animate-spin" />
          : variant === 'error'
            ? <AlertCircle size={16} />
            : <CheckCircle size={16} />}
        <span>{isLoading ? 'Saving...' : message}</span>
      </div>
    </div>
  )
}
