'use client'

import { useEffect, useRef, useState } from 'react'
import { X, SlidersHorizontal } from 'lucide-react'
import { TemperatureSetPoints } from './TemperatureSetPoints'
import { PowerScheduleSection } from './PowerScheduleSection'
import { AlarmScheduleSection } from './AlarmScheduleSection'
import { ApplyToOtherDays } from './ApplyToOtherDays'
import type { DayOfWeek } from './DaySelector'
import type { PowerSchedule, AlarmSchedule } from '@/src/hooks/useSchedule'

interface ManualControlsSheetProps {
  selectedDay: DayOfWeek
  selectedDays: Set<DayOfWeek>
  powerSchedules: PowerSchedule[]
  alarmSchedules: AlarmSchedule[]
  isLoading: boolean
  hasScheduleData: boolean
  isApplying: boolean
  onApplyToOtherDays: (targetDays: DayOfWeek[]) => void
}

/**
 * Bottom sheet containing manual schedule controls:
 * temperature set points, power schedule, alarm schedule, apply to other days.
 *
 * Slides up from the bottom with a backdrop. Dismissible via X or backdrop tap.
 */
export function ManualControlsSheet({
  selectedDay,
  selectedDays,
  powerSchedules,
  alarmSchedules,
  isLoading,
  hasScheduleData,
  isApplying,
  onApplyToOtherDays,
}: ManualControlsSheetProps) {
  const [open, setOpen] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)
  const [dragY, setDragY] = useState(0)
  const dragStartRef = useRef<number | null>(null)

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    }
    else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [open])

  const handleTouchStart = (e: React.TouchEvent) => {
    dragStartRef.current = e.touches[0].clientY
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (dragStartRef.current === null) return
    const delta = e.touches[0].clientY - dragStartRef.current
    if (delta > 0) {
      setDragY(delta)
    }
  }

  const handleTouchEnd = () => {
    if (dragY > 120) {
      setOpen(false)
    }
    setDragY(0)
    dragStartRef.current = null
  }

  return (
    <>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-sm font-medium text-zinc-400 transition-colors hover:border-zinc-700 hover:text-zinc-300 active:scale-[0.98]"
      >
        <SlidersHorizontal size={14} />
        Manual Controls
      </button>

      {/* Sheet overlay */}
      {open && (
        <div className="fixed inset-0 z-50 flex flex-col">
          {/* Backdrop */}
          <div
            className="flex-1 bg-black/60 transition-opacity"
            onClick={() => setOpen(false)}
          />

          {/* Sheet */}
          <div
            ref={sheetRef}
            className="flex max-h-[85dvh] flex-col rounded-t-2xl border-t border-zinc-800 bg-zinc-950 transition-transform duration-200"
            style={{
              transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
            }}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-2 pb-1">
              <div className="h-1 w-8 rounded-full bg-zinc-700" />
            </div>

            {/* Header */}
            <div className="flex items-center justify-between px-4 pb-3">
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={14} className="text-zinc-500" />
                <span className="text-sm font-medium text-zinc-300">Manual Controls</span>
              </div>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-1.5 text-zinc-500 transition-colors hover:bg-zinc-800 active:text-zinc-300"
              >
                <X size={16} />
              </button>
            </div>

            {/* Scrollable content */}
            <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-4">
              {/* Temperature Set Points */}
              <TemperatureSetPoints selectedDay={selectedDay} />

              {/* Power Schedule */}
              <PowerScheduleSection
                schedules={powerSchedules}
                selectedDay={selectedDay}
                isLoading={isLoading}
              />

              {/* Alarm Schedule */}
              <AlarmScheduleSection
                schedules={alarmSchedules}
                selectedDay={selectedDay}
                isLoading={isLoading}
              />

              {/* Apply to other days */}
              <ApplyToOtherDays
                sourceDay={selectedDay}
                selectedDays={selectedDays}
                onApply={onApplyToOtherDays}
                isLoading={isApplying}
                hasSchedule={hasScheduleData}
              />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
