'use client'

import { useCallback, useMemo, useState } from 'react'
import { Plus, Bell } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import type { DayOfWeek } from './DaySelector'
import { AlarmCard, type AlarmGroup } from './AlarmCard'
import { AlarmEditor } from './AlarmEditor'
import { ConfirmDialog } from './ConfirmDialog'

type Side = 'left' | 'right'
type Pattern = 'rise' | 'double'

interface AlarmRow {
  id: number
  side: Side
  dayOfWeek: DayOfWeek
  time: string
  vibrationIntensity: number
  vibrationPattern: Pattern
  duration: number
  alarmTemperature: number
  enabled: boolean
}

const DAY_ORDER: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * Group alarm_schedules rows that share every field except day-of-week.
 * Rows are bucketed by a deterministic signature so "wake at 7am Mon–Fri" renders
 * as one card backed by five row ids.
 */
function groupAlarms(rows: AlarmRow[]): AlarmGroup[] {
  const buckets = new Map<string, AlarmGroup>()
  for (const r of rows) {
    const key = [
      r.time,
      r.vibrationIntensity,
      r.vibrationPattern,
      r.duration,
      r.alarmTemperature,
      r.enabled ? 1 : 0,
    ].join('|')
    const existing = buckets.get(key)
    if (existing) {
      existing.ids.push(r.id)
      existing.days.push(r.dayOfWeek)
    }
    else {
      buckets.set(key, {
        ids: [r.id],
        days: [r.dayOfWeek],
        time: r.time,
        vibrationIntensity: r.vibrationIntensity,
        vibrationPattern: r.vibrationPattern,
        duration: r.duration,
        alarmTemperature: r.alarmTemperature,
        enabled: r.enabled,
      })
    }
  }
  const groups = Array.from(buckets.values())
  for (const g of groups) {
    g.days.sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
  }
  groups.sort((a, b) => a.time.localeCompare(b.time))
  return groups
}

interface AlarmSectionProps {
  side: Side
}

/**
 * Alarms list + editor section. Lives on the schedule page below temperature curves.
 * Reads `schedules.getAll.alarm`, groups identical rows across days into single cards,
 * and routes create/edit through `AlarmEditor`.
 */
export function AlarmSection({ side }: AlarmSectionProps) {
  const { data, isLoading } = trpc.schedules.getAll.useQuery({ side })
  const utils = trpc.useUtils()

  const [editing, setEditing] = useState<AlarmGroup | null>(null)
  const [creating, setCreating] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<AlarmGroup | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const batchUpdate = trpc.schedules.batchUpdate.useMutation()
  const setAlarm = trpc.device.setAlarm.useMutation()

  const groups = useMemo<AlarmGroup[]>(() => {
    const alarms = (data?.alarm ?? []) as AlarmRow[]
    return groupAlarms(alarms)
  }, [data?.alarm])

  const handleCreate = useCallback(() => {
    setEditing(null)
    setCreating(true)
  }, [])

  const handleEdit = useCallback((group: AlarmGroup) => {
    setEditing(group)
    setCreating(false)
  }, [])

  const handleCloseEditor = useCallback(() => {
    setEditing(null)
    setCreating(false)
  }, [])

  const handleTest = useCallback((group: AlarmGroup) => {
    const id = group.ids.join(',')
    setTestingId(id)
    setAlarm.mutate(
      {
        side,
        vibrationIntensity: group.vibrationIntensity,
        vibrationPattern: group.vibrationPattern,
        duration: group.duration,
      },
      { onSettled: () => setTestingId(null) },
    )
  }, [setAlarm, side])

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return
    setDeleteError(null)
    try {
      await batchUpdate.mutateAsync({
        deletes: { alarm: pendingDelete.ids },
      })
      void utils.schedules.getAll.invalidate()
      void utils.schedules.getByDay.invalidate()
      setPendingDelete(null)
    }
    catch (err) {
      // Keep the dialog open so the user can retry or cancel. Surface the failure
      // in a banner — silently closing the dialog after a failed delete leaves the
      // alarm row visible but with no signal to the user that the delete didn't take.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete alarm')
    }
  }, [pendingDelete, batchUpdate, utils])

  const cancelDelete = useCallback(() => {
    setPendingDelete(null)
    setDeleteError(null)
  }, [])

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-zinc-500">
          <Bell size={11} />
          Alarms
        </p>
      </div>

      {isLoading && !data && (
        <div className="h-20 animate-pulse rounded-2xl bg-zinc-900" />
      )}

      {!isLoading && groups.length === 0 && (
        <div className="rounded-2xl border border-dashed border-amber-500/30 bg-amber-500/5 p-5 text-center">
          <p className="text-sm font-medium text-white">No alarms yet</p>
          <p className="mt-1 text-xs text-zinc-400">
            Set a wake-up alarm — the cover buzzes you awake.
          </p>
          <button
            onClick={handleCreate}
            className="mt-3 inline-flex h-10 items-center gap-1.5 rounded-xl bg-amber-500 px-4 text-sm font-semibold text-zinc-950 active:bg-amber-600"
          >
            <Plus size={14} />
            Add alarm
          </button>
        </div>
      )}

      {groups.length > 0 && (
        <>
          <div className="space-y-2">
            {groups.map(group => (
              <AlarmCard
                key={group.ids.join(',')}
                group={group}
                onEdit={() => handleEdit(group)}
                onDelete={() => setPendingDelete(group)}
                onTest={() => handleTest(group)}
                isTesting={testingId === group.ids.join(',')}
              />
            ))}
          </div>
          <button
            onClick={handleCreate}
            className="flex h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-zinc-700 text-sm font-medium text-zinc-400 active:bg-zinc-900"
          >
            <Plus size={14} />
            Add another alarm
          </button>
        </>
      )}

      <AlarmEditor
        open={creating || editing !== null}
        onClose={handleCloseEditor}
        side={side}
        existingGroup={editing}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete alarm?"
        message={
          deleteError
            ? `Couldn't delete: ${deleteError}. Try again, or cancel.`
            : `This will remove the alarm for ${pendingDelete?.days.length === 7 ? 'every day' : `${pendingDelete?.days.length ?? 0} day${(pendingDelete?.days.length ?? 0) === 1 ? '' : 's'}`}. The cover will no longer buzz at this time.`
        }
        confirmLabel={deleteError ? 'Retry' : 'Delete'}
        variant="danger"
        onConfirm={() => void confirmDelete()}
        onCancel={cancelDelete}
      />
    </div>
  )
}
