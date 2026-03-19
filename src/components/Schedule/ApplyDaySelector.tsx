'use client'

import { cn } from '@/lib/utils'
import { DAYS, type DayOfWeek } from './DaySelector'

interface ApplyDaySelectorProps {
  /** Set of currently selected days */
  selectedDays: Set<DayOfWeek>
  /** Called when a day is toggled on/off */
  onToggle: (day: DayOfWeek) => void
  /** Currently active/primary day */
  activeDay?: DayOfWeek
  /** Called when active day changes */
  onActiveDayChange?: (day: DayOfWeek) => void
}

/**
 * Multi-select day selector for "Apply to Days" functionality.
 * Used in CurveEditor and schedule bulk operations.
 */
export function ApplyDaySelector({
  selectedDays,
  onToggle,
  activeDay,
  onActiveDayChange,
}: ApplyDaySelectorProps) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wider text-zinc-500">
        Apply to Days
      </div>
      <div className="flex justify-between gap-1.5">
        {DAYS.map(({ key, short }) => {
          const isSelected = selectedDays.has(key)
          const isActive = key === activeDay

          return (
            <button
              key={key}
              type="button"
              onClick={() => {
                onToggle(key)
                onActiveDayChange?.(key)
              }}
              className={cn(
                'flex h-11 w-11 items-center justify-center rounded-full text-xs font-semibold transition-all duration-150',
                isActive
                  ? 'bg-sky-500 text-white ring-2 ring-sky-500/30'
                  : isSelected
                    ? 'bg-zinc-700 text-white'
                    : 'bg-zinc-900 text-zinc-500 active:bg-zinc-800',
              )}
            >
              {short}
            </button>
          )
        })}
      </div>
    </div>
  )
}
