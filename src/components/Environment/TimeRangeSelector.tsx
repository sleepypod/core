'use client'

import { cn } from '@/lib/utils'

export type TimeRange = '1h' | '6h' | '12h' | '24h'

const ranges: { value: TimeRange; label: string }[] = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '12h', label: '12H' },
  { value: '24h', label: '24H' },
]

export function getDateRangeFromTimeRange(range: TimeRange): { startDate: Date; endDate: Date } {
  const now = new Date()
  const hours = parseInt(range)
  const startDate = new Date(now.getTime() - hours * 60 * 60 * 1000)
  return { startDate, endDate: now }
}

interface TimeRangeSelectorProps {
  value: TimeRange
  onChange: (range: TimeRange) => void
}

export function TimeRangeSelector({ value, onChange }: TimeRangeSelectorProps) {
  return (
    <div className="flex gap-1 rounded-lg bg-zinc-900 p-1">
      {ranges.map(range => (
        <button
          key={range.value}
          onClick={() => onChange(range.value)}
          className={cn(
            'rounded-md px-3 min-h-[44px] flex items-center justify-center text-xs font-semibold transition-colors',
            value === range.value
              ? 'bg-zinc-700 text-white'
              : 'text-zinc-500 active:bg-zinc-800',
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  )
}
