'use client'

import { useCallback, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import clsx from 'clsx'
import { trpc } from '@/src/utils/trpc'
import { useSchedule } from '@/src/hooks/useSchedule'
import { useScheduleActive } from '@/src/hooks/useScheduleActive'
import { useSide } from '@/src/providers/SideProvider'
import type { SideSelection } from '@/src/providers/SideProvider'
import { useSideNames } from '@/src/hooks/useSideNames'
import { groupDaysBySharedCurve } from '@/src/lib/scheduleGrouping'
import type { ScheduleGroup } from '@/src/lib/scheduleGrouping'
import type { DayOfWeek } from './DaySelector'
import { CurveCard } from './CurveCard'
import { CurveEditor } from './CurveEditor'
import { ConfirmDialog } from './ConfirmDialog'
import { ScheduleToggle } from './ScheduleToggle'
import { SchedulerConfirmation } from './SchedulerConfirmation'

/**
 * Read-only schedule view: lists curves (groups of days sharing a temperature
 * schedule) with Edit/Delete actions per curve and a "+ Create New Curve"
 * button. All editing happens in the full-screen `CurveEditor`.
 */
export function SchedulePage() {
  const { primarySide: side, selectedSide, selectSide } = useSide()
  const {
    confirmMessage,
    isPowerEnabled,
    isApplying,
    isMutating,
    toggleAllSchedules,
    deleteCurve,
    setSelectedDays,
    isLoading: hookLoading,
  } = useSchedule()

  const { nextEvent } = useScheduleActive()
  const { leftName, rightName } = useSideNames()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })

  const [editingCurve, setEditingCurve] = useState<{ days: DayOfWeek[], setPoints: Array<{ time: string, temperature: number }> } | null>(null)
  const [creatingCurve, setCreatingCurve] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<{ days: DayOfWeek[], label: string } | null>(null)

  const groups = useMemo<ScheduleGroup[]>(() => {
    if (!data?.temperature) return []
    return groupDaysBySharedCurve(data.temperature)
  }, [data?.temperature])

  // Curves to render: ones with set points OR explicitly paused
  const visibleGroups = useMemo(
    () => groups.filter(g => g.setPoints.length > 0 || g.allDisabled),
    [groups],
  )

  const hasAnyCurves = visibleGroups.length > 0

  const handleEdit = useCallback((group: ScheduleGroup) => {
    setEditingCurve({ days: group.days, setPoints: group.setPoints })
    setSelectedDays(new Set(group.days))
  }, [setSelectedDays])

  const handleCreate = useCallback(() => {
    setCreatingCurve(true)
  }, [])

  const handleDelete = useCallback((group: ScheduleGroup) => {
    const labelDays = group.days.length === 7
      ? 'every day'
      : group.days.length === 1
        ? group.days[0]
        : `${group.days.length} days`
    setPendingDelete({ days: group.days, label: labelDays })
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    try {
      await deleteCurve(pendingDelete.days)
    }
    finally {
      setPendingDelete(null)
    }
  }, [pendingDelete, deleteCurve])

  const closeEditor = useCallback(() => {
    setEditingCurve(null)
    setCreatingCurve(false)
  }, [])

  return (
    <div className="space-y-3 sm:space-y-4">
      {/* Side selector — left / right / both (writes apply to selection) */}
      <div className="mb-1">
        <SideSelector
          value={selectedSide}
          onChange={selectSide}
          leftName={leftName}
          rightName={rightName}
        />
      </div>

      {/* Next scheduled event hint */}
      {isPowerEnabled && nextEvent && (
        <p className="px-1 text-[11px] uppercase tracking-wider text-zinc-500">
          Next set point
          {' '}
          <span className="font-medium text-zinc-300">{nextEvent.time}</span>
          {' · '}
          <span className="font-medium text-zinc-300">
            {nextEvent.temperature}
            °F
          </span>
        </p>
      )}

      {/* Schedule on/off toggle */}
      <ScheduleToggle
        enabled={isPowerEnabled}
        onToggle={() => void toggleAllSchedules()}
        isLoading={isMutating || hookLoading}
      />

      {/* Confirmation banner */}
      <SchedulerConfirmation
        message={confirmMessage}
        isLoading={isApplying}
        variant={confirmMessage?.includes('Failed') ? 'error' : 'success'}
      />

      {/* Error state */}
      {error && (
        <div className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-400">
          Failed to load schedules:
          {' '}
          {error.message}
        </div>
      )}

      {/* Loading state */}
      {isLoading && !data && (
        <div className="h-24 animate-pulse rounded-2xl bg-zinc-900" />
      )}

      {/* Empty state */}
      {!isLoading && !hasAnyCurves && (
        <div className="rounded-2xl border border-dashed border-sky-500/30 bg-sky-500/5 p-6 text-center">
          <p className="text-sm font-medium text-white">No schedule yet</p>
          <p className="mt-1 text-xs text-zinc-400">
            Create a sleep curve to automatically control bed temperature
          </p>
          <button
            onClick={handleCreate}
            className="mt-4 inline-flex h-10 items-center gap-1.5 rounded-xl bg-sky-500 px-4 text-sm font-semibold text-white active:bg-sky-600"
          >
            <Plus size={14} />
            Create Sleep Curve
          </button>
        </div>
      )}

      {/* Curves list */}
      {hasAnyCurves && (
        <>
          <p className="text-[11px] font-medium uppercase tracking-wider text-zinc-500">
            Curves
          </p>
          <div className="space-y-2">
            {visibleGroups.map(group => (
              <CurveCard
                key={group.key}
                group={group}
                onEdit={() => handleEdit(group)}
                onDelete={() => handleDelete(group)}
              />
            ))}
          </div>

          <button
            onClick={handleCreate}
            className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-700 text-sm font-medium text-zinc-400 active:bg-zinc-900"
          >
            <Plus size={14} />
            Create New Curve
          </button>
        </>
      )}

      {/* Edit / Create editor */}
      <CurveEditor
        open={editingCurve !== null || creatingCurve}
        onClose={closeEditor}
        initialDays={editingCurve?.days ?? []}
        initialSetPoints={editingCurve?.setPoints ?? []}
      />

      {/* Delete confirmation */}
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete curve?"
        message={`This will remove the schedule for ${pendingDelete?.label ?? ''}. The Pod won't change temperature on those days until you create a new curve.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

interface SideSelectorProps {
  value: SideSelection
  onChange: (side: SideSelection) => void
  leftName: string
  rightName: string
}

function SideSelector({ value, onChange, leftName, rightName }: SideSelectorProps) {
  const tabs: Array<{ value: SideSelection, label: string }> = [
    { value: 'left', label: leftName },
    { value: 'right', label: rightName },
    { value: 'both', label: 'Both' },
  ]
  return (
    <div className="flex rounded-xl bg-zinc-900 p-1">
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          aria-pressed={value === tab.value}
          className={clsx(
            'flex-1 truncate rounded-lg px-3 py-2 text-xs font-semibold transition-colors',
            value === tab.value
              ? 'bg-sky-500 text-white'
              : 'text-zinc-400 active:bg-zinc-800',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
