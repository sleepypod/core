'use client'

import clsx from 'clsx'

export type TimeRange = 'night' | 'week' | 'month'

interface TimeRangeSelectorProps {
  value: TimeRange
  onChange: (range: TimeRange) => void
}

const ranges: { id: TimeRange; label: string }[] = [
  { id: 'night', label: 'Night' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

/**
 * Pill-style time range selector for night/week/month views.
 * Matches iOS MetricsManager time range concept.
 */
export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <div className="flex rounded-lg bg-zinc-900 p-1">
      {ranges.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={clsx(
            'flex-1 rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-medium transition-colors',
            value === id
              ? 'bg-zinc-700 text-white'
              : 'text-zinc-500 hover:text-zinc-300',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
