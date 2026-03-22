'use client'

import { useState, useCallback } from 'react'
import { ChevronRight, Plus, Thermometer, Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { useSchedules } from '@/src/hooks/useSchedules'
import type { SchedulePhase } from '@/src/hooks/useSchedules'
import type { DayOfWeek } from './DaySelector'
import { SetPointList } from './SetPointCard'
import { SetPointEditor } from './SetPointEditor'

interface TemperatureSetPointsProps {
  selectedDay: DayOfWeek
}

/**
 * Complete temperature set points section for the schedule page.
 * Matches iOS ScheduleScreen's expandable "Set Points" section:
 * - Collapsible disclosure header with count
 * - Horizontal scrolling phase cards with +/- temp controls
 * - Add new set point button
 * - Bottom sheet editor for create/edit
 * - Delete with confirmation
 *
 * All mutations use optimistic updates via useSchedules hook.
 */
export function TemperatureSetPoints({ selectedDay }: TemperatureSetPointsProps) {
  const {
    phases,
    isLoading,
    error,
    createSetPoint,
    updateSetPoint,
    adjustTemperature,
    deleteSetPoint,
    isMutating,
  } = useSchedules(selectedDay)

  const [expanded, setExpanded] = useState(true)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingPhase, setEditingPhase] = useState<SchedulePhase | null>(null)

  const handleTapCard = useCallback((phase: SchedulePhase) => {
    setEditingPhase(phase)
    setEditorOpen(true)
  }, [])

  const handleAddNew = useCallback(() => {
    setEditingPhase(null)
    setEditorOpen(true)
  }, [])

  const handleCloseEditor = useCallback(() => {
    setEditorOpen(false)
    setEditingPhase(null)
  }, [])

  if (isLoading) {
    return (
      <div className="flex items-center justify-center rounded-2xl bg-zinc-900 p-6">
        <Loader2 size={20} className="animate-spin text-zinc-500" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4 text-center text-sm text-red-400">
        Failed to load set points
      </div>
    )
  }

  return (
    <>
      <div className="rounded-2xl bg-zinc-900 p-3 sm:p-4">
        {/* Header with expand/collapse toggle */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2"
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
          <span className="ml-auto">
            <ChevronRight
              size={14}
              className={clsx(
                'text-zinc-600 transition-transform duration-200',
                expanded && 'rotate-90'
              )}
            />
          </span>
        </button>

        {/* Expanded content */}
        {expanded && (
          <div className="mt-3 space-y-3">
            {phases.length > 0
              ? (
                  <SetPointList
                    phases={phases}
                    onAdjustTemp={adjustTemperature}
                    onDelete={deleteSetPoint}
                    onTapCard={handleTapCard}
                    disabled={isMutating}
                  />
                )
              : (
                  <p className="py-3 text-center text-xs text-zinc-600">
                    No temperature set points configured
                  </p>
                )}

            {/* Add set point button */}
            <button
              onClick={handleAddNew}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-700 py-2.5 text-xs font-medium text-zinc-400 transition-colors active:border-sky-500 active:text-sky-400"
            >
              <Plus size={14} />
              Add Set Point
            </button>
          </div>
        )}
      </div>

      {/* Editor bottom sheet */}
      <SetPointEditor
        editingPhase={editingPhase}
        open={editorOpen}
        onClose={handleCloseEditor}
        onCreate={createSetPoint}
        onUpdate={updateSetPoint}
        onDelete={deleteSetPoint}
      />
    </>
  )
}
