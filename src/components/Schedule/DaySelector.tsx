'use client'

import { cn } from '@/lib/utils'
import { DAYS, type DayOfWeek } from './days'

export { DAYS, DAY_GROUPS, getCurrentDay, type DayOfWeek } from './days'

/**
 * DaySelector supports two modes:
 *
 * 1. **Single-select** (activeDay + onActiveDayChange only):
 *    Simple day picker — tapping switches the active day.
 *
 * 2. **Multi-select** (selectedDays + onSelectedDaysChange):
 *    Multi-day picker for bulk operations. Primary day is highlighted,
 *    additional selected days shown with reduced opacity.
 *    - Tap unselected day → add to selection & make primary
 *    - Tap selected day (not last) → remove from selection
 *    - Tap sole selected day → no-op (always keep at least 1)
 */
interface DaySelectorProps {
  /** Primary active day for viewing */
  activeDay: DayOfWeek
  /** Called when active day changes */
  onActiveDayChange: (day: DayOfWeek) => void
  /** Set of all selected days (enables multi-select mode when provided) */
  selectedDays?: Set<DayOfWeek>
  /** Called when the selected days set changes (multi-select mode) */
  onSelectedDaysChange?: (days: Set<DayOfWeek>) => void
}

export function DaySelector({
  activeDay,
  onActiveDayChange,
  selectedDays,
  onSelectedDaysChange,
}: DaySelectorProps) {
  const isMultiSelect = !!selectedDays && !!onSelectedDaysChange

  const handleTap = (day: DayOfWeek) => {
    if (!isMultiSelect) {
      // Single-select mode: just switch active day
      onActiveDayChange(day)
      return
    }

    // Multi-select mode
    const isSelected = selectedDays.has(day)

    if (isSelected && selectedDays.size > 1) {
      // Deselect day (keep at least one)
      const next = new Set(selectedDays)
      next.delete(day)
      onSelectedDaysChange(next)
      // If we removed the primary day, switch to first remaining
      if (day === activeDay) {
        const first = DAYS.find(d => next.has(d.key))
        if (first) onActiveDayChange(first.key)
      }
    }
    else if (!isSelected) {
      // Add to selection and make primary
      const next = new Set(selectedDays)
      next.add(day)
      onSelectedDaysChange(next)
      onActiveDayChange(day)
    }
    else {
      // Sole selected day — just ensure it's primary
      onActiveDayChange(day)
    }
  }

  return (
    <div className="flex items-center justify-between gap-0.5 sm:gap-1">
      {DAYS.map(({ key, short, label }) => {
        const isPrimary = key === activeDay
        const isSelected = selectedDays?.has(key) ?? isPrimary

        return (
          <button
            key={key}
            type="button"
            onClick={() => handleTap(key)}
            aria-label={label}
            aria-pressed={isSelected}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-full text-[13px] font-semibold transition-all duration-150 sm:text-sm',
              isPrimary
                ? 'bg-sky-500 text-white'
                : isMultiSelect && isSelected
                  ? 'bg-sky-500/30 text-sky-300'
                  : 'bg-zinc-900 text-zinc-500 active:bg-zinc-800',
            )}
          >
            {short}
          </button>
        )
      })}
    </div>
  )
}

