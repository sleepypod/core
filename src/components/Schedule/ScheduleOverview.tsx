'use client'

import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/hooks/useSide'
import type { DayOfWeek } from './DaySelector'
import { AlarmClock, Power, Zap } from 'lucide-react'
import clsx from 'clsx'
import { TemperatureSetPoints } from './TemperatureSetPoints'
import { formatTime12h } from './TimeInput'

interface ScheduleOverviewProps {
  selectedDay: DayOfWeek
}

/**
 * Displays an overview of all schedules (power, temperature, alarm)
 * for the selected day and side.
 *
 * Temperature schedules use the interactive TemperatureSetPoints component
 * with full CRUD support and optimistic updates.
 * Power and alarm schedules are displayed as read-only cards.
 */
export function ScheduleOverview({ selectedDay }: ScheduleOverviewProps) {
  const { side } = useSide()

  const { data, isLoading, error } = trpc.schedules.getByDay.useQuery({
    side,
    dayOfWeek: selectedDay,
  })

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map(i => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-2xl bg-zinc-900"
          />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-4 text-center text-sm text-red-400">
        Failed to load schedules: {error.message}
      </div>
    )
  }

  const { power, alarm } = data ?? { power: [], alarm: [] }

  return (
    <div className="space-y-3">
      {/* Power Schedules */}
      {power.map((ps: any) => (
        <PowerScheduleCard key={ps.id} schedule={ps} />
      ))}

      {/* Temperature Set Points — interactive CRUD */}
      <TemperatureSetPoints selectedDay={selectedDay} />

      {/* Alarm Schedules */}
      {alarm.map((as: any) => (
        <AlarmScheduleCard key={as.id} schedule={as} />
      ))}
    </div>
  )
}

function PowerScheduleCard({ schedule }: { schedule: any }) {
  return (
    <div
      className={clsx(
        'rounded-2xl bg-zinc-900 p-4',
        !schedule.enabled && 'opacity-50'
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <Power size={16} className="text-emerald-400" />
        <h3 className="text-sm font-medium text-zinc-300">Auto Schedule</h3>
        <span
          className={clsx(
            'ml-auto rounded-full px-2 py-0.5 text-xs',
            schedule.enabled
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-zinc-800 text-zinc-500'
          )}
        >
          {schedule.enabled ? 'Active' : 'Off'}
        </span>
      </div>
      <div className="flex items-center gap-4 text-sm">
        <div className="flex items-center gap-1.5 text-zinc-400">
          <Zap size={12} className="text-emerald-400" />
          <span>On: {formatTime12h(schedule.onTime)}</span>
        </div>
        <div className="flex items-center gap-1.5 text-zinc-400">
          <Power size={12} className="text-zinc-500" />
          <span>Off: {formatTime12h(schedule.offTime)}</span>
        </div>
      </div>
      <div className="mt-2 text-xs text-zinc-500">
        Start at {schedule.onTemperature}°F
      </div>
    </div>
  )
}

function AlarmScheduleCard({ schedule }: { schedule: any }) {
  return (
    <div
      className={clsx(
        'rounded-2xl bg-zinc-900 p-4',
        !schedule.enabled && 'opacity-50'
      )}
    >
      <div className="mb-2 flex items-center gap-2">
        <AlarmClock size={16} className="text-amber-400" />
        <h3 className="text-sm font-medium text-zinc-300">Wake Alarm</h3>
        <span
          className={clsx(
            'ml-auto rounded-full px-2 py-0.5 text-xs',
            schedule.enabled
              ? 'bg-amber-500/20 text-amber-400'
              : 'bg-zinc-800 text-zinc-500'
          )}
        >
          {schedule.enabled ? 'Active' : 'Off'}
        </span>
      </div>
      <div className="text-lg font-semibold text-white">
        {formatTime12h(schedule.time)}
      </div>
      <div className="mt-2 flex gap-3 text-xs text-zinc-500">
        <span>
          {schedule.vibrationPattern === 'rise' ? 'Gradual' : 'Double pulse'}
        </span>
        <span>·</span>
        <span>Intensity {schedule.vibrationIntensity}%</span>
        <span>·</span>
        <span>{schedule.duration}s</span>
      </div>
      <div className="mt-1 text-xs text-zinc-500">
        Alarm temp: {schedule.alarmTemperature}°F
      </div>
    </div>
  )
}
