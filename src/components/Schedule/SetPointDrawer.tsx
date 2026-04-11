'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import clsx from 'clsx'
import { CurveChart } from './CurveChart'
import { SetPointCard } from './SetPointCard'
import { SetPointEditor } from './SetPointEditor'
import { useSchedules } from '@/src/hooks/useSchedules'
import type { SchedulePhase } from '@/src/hooks/useSchedules'
import { DAYS } from './DaySelector'
import type { DayOfWeek } from './DaySelector'
import type { CurvePoint } from '@/src/lib/sleepCurve/types'
import { timeStringToMinutes } from '@/src/lib/sleepCurve/generate'

const DAY_SHORT: Record<DayOfWeek, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed',
  thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
}

interface SetPointDrawerProps {
  open: boolean
  onClose: () => void
  selectedDay: DayOfWeek
  selectedDays?: Set<DayOfWeek>
}

export function SetPointDrawer({ open, onClose, selectedDay, selectedDays }: SetPointDrawerProps) {
  const {
    phases,
    isLoading,
    createSetPoint,
    updateSetPoint,
    adjustTemperature,
    deleteSetPoint,
    isMutating,
  } = useSchedules(selectedDay)

  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editingPhase, setEditingPhase] = useState<SchedulePhase | null>(null)
  const rowRefs = useRef<Map<number, HTMLDivElement>>(new Map())

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

  const curveData = (() => {
    if (phases.length === 0)
      return null

    const temps = phases.map(p => p.temperature)
    const min = Math.min(...temps)
    const max = Math.max(...temps)
    const btMin = timeStringToMinutes(phases[0].time)

    const points: CurvePoint[] = phases.map((p, i) => {
      let tMin = timeStringToMinutes(p.time) - btMin
      if (tMin < -120) tMin += 24 * 60

      const frac = phases.length > 1 ? i / (phases.length - 1) : 0
      const phase = frac < 0.1
        ? 'warmUp' as const
        : frac < 0.25
          ? 'coolDown' as const
          : frac < 0.55
            ? 'deepSleep' as const
            : frac < 0.75
              ? 'maintain' as const
              : frac < 0.9
                ? 'preWake' as const
                : 'wake' as const

      return { minutesFromBedtime: tMin, tempOffset: p.temperature - 80, phase }
    }).sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)

    return { points, bedtimeMinutes: btMin, minTempF: min, maxTempF: max }
  })()

  const handleChartSelect = useCallback((index: number) => {
    setSelectedIndex(index)
    const el = rowRefs.current.get(index)
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  const handleRowTap = useCallback((phase: SchedulePhase, index: number) => {
    setSelectedIndex(index)
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

  if (!open) return null

  const activeDays = selectedDays ? Array.from(selectedDays) : [selectedDay]

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-zinc-950">
      {/* Header with day pills matching week overview style */}
      <div className="px-4 py-3 border-b border-zinc-800">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-white">Set Points</span>
          <span className="text-[10px] text-zinc-500">
            {phases.length}
            {' '}
            {phases.length === 1 ? 'point' : 'points'}
          </span>
        </div>
        <div className="flex gap-1">
          {DAYS.map(({ key }) => {
            const isActive = activeDays.includes(key)
            return (
              <span
                key={key}
                className={clsx(
                  'inline-flex h-6 min-w-[2rem] items-center justify-center rounded-full px-1.5 text-[10px] font-semibold',
                  isActive
                    ? 'bg-sky-500/20 text-sky-400'
                    : 'bg-transparent text-zinc-700',
                )}
              >
                {DAY_SHORT[key]}
              </span>
            )
          })}
        </div>
      </div>

      {/* Pinned chart */}
      {curveData && (
        <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <CurveChart
            points={curveData.points}
            bedtimeMinutes={curveData.bedtimeMinutes}
            minTempF={curveData.minTempF}
            maxTempF={curveData.maxTempF}
            selectedIndex={selectedIndex}
            onSelectIndex={handleChartSelect}
            compact
          />
        </div>
      )}

      {/* Scrollable set point list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 pb-24">
        {isLoading
          ? (
              <div className="flex items-center justify-center py-12">
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-zinc-600 border-t-sky-400" />
              </div>
            )
          : phases.length === 0
            ? (
                <p className="py-8 text-center text-xs text-zinc-600">
                  No temperature set points configured
                </p>
              )
            : (
                <div className="space-y-1.5">
                  {phases.map((phase, index) => (
                    <div
                      key={phase.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(index, el)
                        else rowRefs.current.delete(index)
                      }}
                      className={
                        selectedIndex === index
                          ? 'rounded-xl ring-1 ring-sky-500/50'
                          : ''
                      }
                    >
                      <SetPointCard
                        phase={phase}
                        onAdjustTemp={adjustTemperature}
                        onDelete={deleteSetPoint}
                        onTapCard={p => handleRowTap(p, index)}
                        disabled={isMutating}
                      />
                    </div>
                  ))}
                </div>
              )}
      </div>

      {/* Floating bottom bar */}
      <div className="pb-safe absolute inset-x-0 bottom-0 flex gap-3 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur-sm">
        <button
          onClick={handleAddNew}
          className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-zinc-700 text-sm font-medium text-zinc-300 transition-colors active:bg-zinc-800"
        >
          <Plus size={14} />
          Add Point
        </button>
        <button
          onClick={onClose}
          className="flex h-11 flex-1 items-center justify-center rounded-xl bg-sky-500 text-sm font-semibold text-white transition-colors active:bg-sky-600"
        >
          Done
        </button>
      </div>

      {/* Editor */}
      <SetPointEditor
        editingPhase={editingPhase}
        open={editorOpen}
        onClose={handleCloseEditor}
        onCreate={createSetPoint}
        onUpdate={updateSetPoint}
        onDelete={deleteSetPoint}
      />
    </div>
  )
}
