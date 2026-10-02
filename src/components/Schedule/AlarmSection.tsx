'use client'

import { useCallback, useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, SectionLabel, Skeleton } from '@/src/components/ds'
import type { SideSelection } from '@/src/providers/SideProvider'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
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
export function groupAlarms(rows: AlarmRow[]): AlarmGroup[] {
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
  /** Page-level side selection; seeds the editor's side control for new alarms. */
  selectedSide?: SideSelection
}

/**
 * Alarms column on the schedule page. Reads `schedules.getAll.alarm`, groups
 * identical rows across days into single cards, and routes create/edit through
 * `AlarmEditor` and deletes through a confirmation dialog.
 */
export function AlarmSection({ side, selectedSide = side }: AlarmSectionProps) {
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })
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

  const handleRequestDelete = useCallback((group: AlarmGroup) => {
    setEditing(null)
    setCreating(false)
    setPendingDelete(group)
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
      // in the dialog — silently closing it after a failed delete leaves the
      // alarm visible with no signal that the delete didn't take.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete alarm')
    }
  }, [pendingDelete, batchUpdate, utils])

  const cancelDelete = useCallback(() => {
    setPendingDelete(null)
    setDeleteError(null)
  }, [])

  const dayCount = pendingDelete?.days.length ?? 0

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SectionLabel right={groups.length > 0 ? <span className="font-mono">{groups.length}</span> : undefined}>
        Alarms
      </SectionLabel>

      {isLoading && !data && <Skeleton className="h-[92px]" />}

      {error && (
        <InlineError>
          Failed to load alarms:
          {' '}
          {error.message}
        </InlineError>
      )}

      {groups.map(group => (
        <AlarmCard
          key={group.ids.join(',')}
          group={group}
          onEdit={() => handleEdit(group)}
          onTest={() => handleTest(group)}
          isTesting={testingId === group.ids.join(',')}
        />
      ))}

      {setAlarm.error && <InlineError>{`Test failed: ${setAlarm.error.message}`}</InlineError>}

      {!isLoading && (
        <Button
          variant="dashed"
          icon={Plus}
          full
          onClick={handleCreate}
          className="rounded-card py-[11px] max-[899px]:h-11 max-[899px]:text-sm"
        >
          Add alarm
        </Button>
      )}

      <AlarmEditor
        open={creating || editing !== null}
        onClose={handleCloseEditor}
        side={side}
        defaultSide={selectedSide}
        existingGroup={editing}
        onRequestDelete={handleRequestDelete}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete alarm?"
        message={
          deleteError
            ? `Couldn't delete: ${deleteError}. Try again, or cancel.`
            : `This will remove the alarm for ${dayCount === 7 ? 'every day' : `${dayCount} day${dayCount === 1 ? '' : 's'}`}. The cover will no longer buzz at this time.`
        }
        confirmLabel={deleteError ? 'Retry' : 'Delete'}
        variant="danger"
        busy={batchUpdate.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={cancelDelete}
      />
    </div>
  )
}
