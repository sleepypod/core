'use client'

import { useState } from 'react'
import { ChevronRight, Thermometer, Loader2 } from 'lucide-react'
import { useSchedules } from '@/src/hooks/useSchedules'
import type { DayOfWeek } from './DaySelector'
import { SetPointDrawer } from './SetPointDrawer'

interface TemperatureSetPointsProps {
  selectedDay: DayOfWeek
  selectedDays?: Set<DayOfWeek>
}

export function TemperatureSetPoints({ selectedDay, selectedDays }: TemperatureSetPointsProps) {
  const { phases, isLoading, isMutating } = useSchedules(selectedDay)
  const [drawerOpen, setDrawerOpen] = useState(false)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-2xl bg-zinc-900 p-6">
        <Loader2 size={20} className="animate-spin text-zinc-500" />
      </div>
    )
  }

  const tempRange = phases.length > 0
    ? `${Math.min(...phases.map(p => p.temperature))}°–${Math.max(...phases.map(p => p.temperature))}°`
    : null

  return (
    <>
      <button
        onClick={() => setDrawerOpen(true)}
        className="flex w-full items-center gap-2 rounded-2xl bg-zinc-900 p-3 sm:p-4 text-left transition-colors active:bg-zinc-800"
      >
        <Thermometer size={16} className="text-sky-400" />
        <span className="text-xs font-medium text-zinc-400">Set Points</span>
        {phases.length > 0 && (
          <span className="text-[10px] text-zinc-600">
            (
            {phases.length}
            )
          </span>
        )}
        {isMutating && (
          <Loader2 size={12} className="animate-spin text-sky-400" />
        )}
        <div className="ml-auto flex items-center gap-2">
          {tempRange && (
            <span className="text-[11px] font-medium text-zinc-300">{tempRange}</span>
          )}
          <ChevronRight size={14} className="text-zinc-600" />
        </div>
      </button>

      <SetPointDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        selectedDay={selectedDay}
        selectedDays={selectedDays}
      />
    </>
  )
}
