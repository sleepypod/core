'use client'

import { cn } from '@/lib/utils'

interface ScheduleToggleProps {
  /** Whether the schedule is currently enabled */
  enabled: boolean
  /** Called when user toggles the switch */
  onToggle: () => void
  /** Number of days affected by this toggle */
  affectedDayCount: number
  /** Whether a mutation is in-flight */
  isLoading?: boolean
  /** Next scheduled time string (e.g. "10:30 PM") */
  nextScheduleTime?: string | null
}

export function ScheduleToggle({
  enabled,
  onToggle,
  affectedDayCount,
  isLoading = false,
  nextScheduleTime,
}: ScheduleToggleProps) {
  return (
    <div className="rounded-xl bg-zinc-900 px-4 py-3">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">Schedule</span>
            <span className={cn(
              'inline-block h-2 w-2 rounded-full',
              enabled ? 'bg-emerald-400' : 'bg-zinc-600',
            )}
            />
          </div>
          <span className="text-xs text-zinc-400">
            {affectedDayCount > 1
              ? `Applies to ${affectedDayCount} selected days`
              : nextScheduleTime
                ? `Automatically control power and temperature · Next at ${nextScheduleTime}`
                : 'Automatically control power and temperature'}
          </span>
        </div>

        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Toggle schedule"
          disabled={isLoading}
          onClick={onToggle}
          className={cn(
            'flex min-h-[44px] min-w-[48px] items-center justify-center',
            isLoading && 'opacity-50'
          )}
        >
          <span className={cn(
            'relative h-7 w-12 rounded-full transition-colors duration-200',
            enabled ? 'bg-sky-500' : 'bg-zinc-700',
          )}
          >
            <span
              className={cn(
                'absolute top-0.5 left-0.5 h-6 w-6 rounded-full bg-white transition-transform duration-200',
                enabled && 'translate-x-5'
              )}
            />
          </span>
        </button>
      </div>
    </div>
  )
}
