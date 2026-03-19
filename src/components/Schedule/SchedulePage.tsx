'use client'

import { useSchedule } from '@/src/hooks/useSchedule'
import { DaySelector } from './DaySelector'
import { PowerScheduleSection } from './PowerScheduleSection'
import { AlarmScheduleSection } from './AlarmScheduleSection'
import { TemperatureSetPoints } from './TemperatureSetPoints'
import { ScheduleWeekOverview } from './ScheduleWeekOverview'
import { ScheduleToggle } from './ScheduleToggle'
import { ApplyToOtherDays } from './ApplyToOtherDays'
import { SchedulerConfirmation } from './SchedulerConfirmation'
import { trpc } from '@/src/utils/trpc'

/**
 * Complete Schedule page layout composing:
 * - Side selector (left/right via global useSide)
 * - Day selector (7 circular day buttons with multi-select for bulk ops)
 * - Schedule enable/disable toggle (bulk across selected days)
 * - Scheduler reload confirmation banner
 * - Temperature set points (interactive CRUD with optimistic updates)
 * - Power schedule section (on/off time, temperature, toggle — with mutations)
 * - Alarm schedule section (time, vibration, pattern, duration — with mutations)
 * - Apply to other days (copy source day schedule to targets)
 * - Week overview summary (schedule coverage across all days)
 */
export function SchedulePage() {
  const {
    side,
    selectedDay,
    selectedDays,
    setSelectedDay,
    setSelectedDays,
    confirmMessage,
    isPowerEnabled,
    hasScheduleData,
    isApplying,
    isMutating,
    toggleAllSchedules,
    applyToOtherDays,
    isLoading: hookLoading,
  } = useSchedule()

  // Also keep the direct getAll query for PowerScheduleSection/AlarmScheduleSection props
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Day Selector — multi-select for bulk operations */}
      <DaySelector
        activeDay={selectedDay}
        onActiveDayChange={setSelectedDay}
        selectedDays={selectedDays}
        onSelectedDaysChange={setSelectedDays}
      />

      {/* Multi-day info banner */}
      {selectedDays.size > 1 && (
        <div className="rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-400">
          {selectedDays.size} days selected — toggle affects all selected days
        </div>
      )}

      {/* Schedule enable/disable toggle (bulk across selected days) */}
      <ScheduleToggle
        enabled={isPowerEnabled}
        onToggle={() => void toggleAllSchedules()}
        affectedDayCount={selectedDays.size}
        isLoading={isMutating || hookLoading}
      />

      {/* Scheduler reload confirmation banner */}
      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">
          Failed to load schedules: {error.message}
        </div>
      )}

      {/* Temperature Set Points — interactive CRUD with optimistic updates */}
      <TemperatureSetPoints selectedDay={selectedDay} />

      {/* Power Schedule — on/off times, start temperature, enable toggle */}
      <PowerScheduleSection
        schedules={data?.power ?? []}
        selectedDay={selectedDay}
        isLoading={isLoading}
      />

      {/* Alarm Schedule — time, vibration config, pattern, duration */}
      <AlarmScheduleSection
        schedules={data?.alarm ?? []}
        selectedDay={selectedDay}
        isLoading={isLoading}
      />

      {/* Apply to other days — copy current day schedule to target days */}
      <ApplyToOtherDays
        sourceDay={selectedDay}
        selectedDays={selectedDays}
        onApply={(targetDays) => void applyToOtherDays(targetDays)}
        isLoading={isApplying}
        hasSchedule={hasScheduleData}
      />

      {/* Week Overview — at-a-glance schedule coverage */}
      <ScheduleWeekOverview
        selectedDay={selectedDay}
        onDayChange={(day) => {
          setSelectedDay(day)
          setSelectedDays(new Set([day]))
        }}
      />
    </div>
  )
}
