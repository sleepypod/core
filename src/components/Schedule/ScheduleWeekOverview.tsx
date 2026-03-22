'use client'

import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import type { DayOfWeek } from './DaySelector'
import { Calendar, Check } from 'lucide-react'
import clsx from 'clsx'

const DAYS_OF_WEEK: { key: DayOfWeek; label: string }[] = [
  { key: 'sunday', label: 'Sun' },
  { key: 'monday', label: 'Mon' },
  { key: 'tuesday', label: 'Tue' },
  { key: 'wednesday', label: 'Wed' },
  { key: 'thursday', label: 'Thu' },
  { key: 'friday', label: 'Fri' },
  { key: 'saturday', label: 'Sat' },
]

interface ScheduleWeekOverviewProps {
  selectedDay: DayOfWeek
  onDayChange: (day: DayOfWeek) => void
}

/**
 * Shows a week-at-a-glance summary using schedules.getAll,
 * indicating which days have schedules configured.
 */
export function ScheduleWeekOverview({
  selectedDay,
  onDayChange,
}: ScheduleWeekOverviewProps) {
  const { side } = useSide()

  const { data, isLoading } = trpc.schedules.getAll.useQuery({ side })

  if (isLoading) {
    return (
      <div className="h-16 animate-pulse rounded-2xl bg-zinc-900" />
    )
  }

  // Build a set of days that have at least one schedule
  const daysWithSchedules = new Set<string>()
  if (data) {
    for (const ps of data.power ?? []) {
      daysWithSchedules.add(ps.dayOfWeek)
    }
    for (const ts of data.temperature ?? []) {
      daysWithSchedules.add(ts.dayOfWeek)
    }
    for (const as of data.alarm ?? []) {
      daysWithSchedules.add(as.dayOfWeek)
    }
  }

  if (daysWithSchedules.size === 0) {
    return null
  }

  return (
    <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
      <div className="mb-2 flex items-center gap-2 sm:mb-3">
        <Calendar size={16} className="text-zinc-500" />
        <h3 className="text-sm font-medium text-zinc-400">Week Overview</h3>
      </div>
      <div className="flex justify-between gap-0.5 sm:gap-1">
        {DAYS_OF_WEEK.map(day => {
          const hasSchedule = daysWithSchedules.has(day.key)
          const isSelected = selectedDay === day.key
          return (
            <button
              key={day.key}
              onClick={() => onDayChange(day.key)}
              className={clsx(
                'flex flex-col items-center gap-1 rounded-lg px-1.5 py-1 transition-colors sm:px-2 sm:py-1.5',
                isSelected && 'bg-zinc-800'
              )}
            >
              <span
                className={clsx(
                  'text-[10px] font-medium',
                  isSelected ? 'text-sky-400' : 'text-zinc-500'
                )}
              >
                {day.label}
              </span>
              {hasSchedule ? (
                <Check
                  size={12}
                  className={clsx(
                    isSelected ? 'text-sky-400' : 'text-emerald-500'
                  )}
                />
              ) : (
                <div className="h-3 w-3 rounded-full border border-zinc-700" />
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
