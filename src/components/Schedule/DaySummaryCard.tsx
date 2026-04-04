'use client'

import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import type { DayScheduleData } from '@/src/hooks/useSchedule'
import { formatTime12h } from './TimeInput'
import type { DayOfWeek } from './DaySelector'
import { DAYS } from './DaySelector'
import { Moon, Sun, Bell, Thermometer, ChevronRight } from 'lucide-react'

interface DaySummaryCardProps {
  day: DayOfWeek
  onTap: () => void
}

export function DaySummaryCard({ day, onTap }: DaySummaryCardProps) {
  const { side } = useSide()
  const { data: rawData, isLoading } = trpc.schedules.getByDay.useQuery({ side, dayOfWeek: day })
  const data = rawData as DayScheduleData | undefined

  const dayLabel = DAYS.find(d => d.key === day)?.label ?? day

  if (isLoading) {
    return (
      <div className="h-24 animate-pulse rounded-xl bg-zinc-900" />
    )
  }

  const power = data?.power?.[0]
  const temps = data?.temperature ?? []
  const alarm = data?.alarm?.[0]

  const hasAnySchedule = !!power || temps.length > 0 || !!alarm

  if (!hasAnySchedule) {
    return (
      <button
        type="button"
        onClick={onTap}
        className="flex w-full items-center justify-between rounded-xl bg-zinc-900 p-4 text-left transition-colors active:bg-zinc-800"
      >
        <div>
          <div className="text-sm font-medium text-white">{dayLabel}</div>
          <div className="mt-1 text-xs text-zinc-500">No schedule — tap to create</div>
        </div>
        <ChevronRight size={16} className="text-zinc-600" />
      </button>
    )
  }

  const tempValues = temps.map(t => t.temperature)
  const minTemp = tempValues.length > 0 ? Math.min(...tempValues) : null
  const maxTemp = tempValues.length > 0 ? Math.max(...tempValues) : null

  return (
    <button
      type="button"
      onClick={onTap}
      className="flex w-full items-center justify-between rounded-xl bg-zinc-900 p-4 text-left transition-colors active:bg-zinc-800"
    >
      <div className="flex-1 space-y-2">
        <div className="text-sm font-medium text-white">{dayLabel}</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {power && (
            <>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Moon size={12} className="text-purple-400" />
                {formatTime12h(power.onTime)}
              </div>
              <div className="flex items-center gap-1.5 text-xs text-zinc-400">
                <Sun size={12} className="text-amber-400" />
                {formatTime12h(power.offTime)}
              </div>
            </>
          )}
          {minTemp !== null && maxTemp !== null && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Thermometer size={12} className="text-sky-400" />
              {minTemp}
              –
              {maxTemp}
              °F
            </div>
          )}
          {alarm && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <Bell size={12} className="text-emerald-400" />
              {formatTime12h(alarm.time)}
            </div>
          )}
        </div>
      </div>
      <ChevronRight size={16} className="text-zinc-600" />
    </button>
  )
}
