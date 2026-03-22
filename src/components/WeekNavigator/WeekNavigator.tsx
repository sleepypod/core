'use client'

import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react'

interface WeekNavigatorProps {
  label: string
  isCurrentWeek: boolean
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
}

/**
 * Week-based date range selector matching iOS WeekNavigatorView.
 * Displays the current week range with prev/next navigation.
 */
export function WeekNavigator({
  label,
  isCurrentWeek,
  onPrevious,
  onNext,
  onToday,
}: WeekNavigatorProps) {
  return (
    <div className="flex items-center justify-between">
      <button
        onClick={onPrevious}
        className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400 active:bg-zinc-700"
        aria-label="Previous week"
      >
        <ChevronLeft size={18} />
      </button>

      <button
        onClick={onToday}
        className="flex min-h-[44px] items-center gap-2 rounded-xl bg-zinc-800/80 px-3 py-2 sm:px-4 sm:py-2.5 active:bg-zinc-700"
        aria-label="Go to current week"
      >
        <Calendar size={14} className="text-sky-400" />
        <span className="text-[13px] font-medium text-white sm:text-sm">{label}</span>
      </button>

      <button
        onClick={onNext}
        disabled={isCurrentWeek}
        className="flex h-11 w-11 items-center justify-center rounded-lg bg-zinc-800/80 text-zinc-400 active:bg-zinc-700 disabled:opacity-30 disabled:cursor-not-allowed"
        aria-label="Next week"
      >
        <ChevronRight size={18} />
      </button>
    </div>
  )
}
