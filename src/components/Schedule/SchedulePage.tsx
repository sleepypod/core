'use client'

import { useSchedule } from '@/src/hooks/useSchedule'
import { DaySelector } from './DaySelector'
import { ScheduleWeekOverview } from './ScheduleWeekOverview'
import { DaySummaryCard } from './DaySummaryCard'
import { ScheduleToggle } from './ScheduleToggle'
import { SchedulerConfirmation } from './SchedulerConfirmation'
import { useRouter, usePathname } from 'next/navigation'

export function SchedulePage() {
  const router = useRouter()
  const pathname = usePathname()
  const {
    selectedDay,
    setSelectedDay,
    confirmMessage,
    isGlobalEnabled,
    isApplying,
    isMutating,
    toggleGlobalSchedules,
    isLoading: hookLoading,
  } = useSchedule()

  // Extract lang from pathname for navigation
  const lang = pathname.split('/')[1] || 'en'

  return (
    <div className="space-y-3 sm:space-y-4">
      <DaySelector
        activeDay={selectedDay}
        onActiveDayChange={setSelectedDay}
      />

      <ScheduleWeekOverview
        selectedDay={selectedDay}
        onDayChange={setSelectedDay}
      />

      <DaySummaryCard
        day={selectedDay}
        onTap={() => router.push(`/${lang}/schedule/${selectedDay}`)}
      />

      <ScheduleToggle
        enabled={isGlobalEnabled}
        onToggle={() => void toggleGlobalSchedules()}
        isLoading={isMutating || hookLoading}
      />

      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />
    </div>
  )
}
