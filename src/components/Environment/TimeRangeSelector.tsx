'use client'

import { cn } from '@/lib/utils'

export type TimeRange = '1h' | '6h' | '12h' | '24h'

const ranges: { value: TimeRange, label: string }[] = [
  { value: '1h', label: '1H' },
  { value: '6h', label: '6H' },
  { value: '12h', label: '12H' },
  { value: '24h', label: '24H' },
]

export function getDateRangeFromTimeRange(range: TimeRange): { startDate: Date, endDate: Date } {
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
    <div className="flex rounded-seg border border-line p-[3px]">
      {ranges.map(range => (
        <button
          key={range.value}
          onClick={() => onChange(range.value)}
          className={cn(
            'flex items-center justify-center rounded-thumb px-3 py-[5px] font-mono text-xs transition-colors',
            value === range.value
              ? 'bg-active text-fg'
              : 'text-fg-2 hover:text-fg',
          )}
        >
          {range.label}
        </button>
      ))}
    </div>
  )
}
