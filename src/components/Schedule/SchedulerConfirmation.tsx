'use client'

import { cn } from '@/lib/utils'
import { CheckCircle, AlertCircle, Loader2 } from 'lucide-react'

interface SchedulerConfirmationProps {
  /** Confirmation/status message to display */
  message: string | null
  /** Whether an operation is in-flight */
  isLoading?: boolean
  /** Type of message for styling */
  variant?: 'success' | 'error' | 'info'
}

/**
 * Toast-style confirmation banner for scheduler reload status.
 * Appears after bulk operations to confirm the scheduler has been updated.
 */
export function SchedulerConfirmation({
  message,
  isLoading = false,
  variant = 'success',
}: SchedulerConfirmationProps) {
  if (!message && !isLoading) return null

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm transition-all',
        variant === 'success' && 'bg-emerald-500/10 text-emerald-400',
        variant === 'error' && 'bg-red-500/10 text-red-400',
        variant === 'info' && 'bg-sky-500/10 text-sky-400'
      )}
      role="status"
      aria-live="polite"
    >
      {isLoading
        ? (
            <Loader2 size={16} className="animate-spin" />
          )
        : variant === 'error'
          ? (
              <AlertCircle size={16} />
            )
          : (
              <CheckCircle size={16} />
            )}
      <span>{isLoading ? 'Updating scheduler...' : message}</span>
    </div>
  )
}
