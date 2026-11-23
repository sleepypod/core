'use client'

import { useTimeFormatter } from '@/src/hooks/useTimeFormatter'

import { Bell, Plus } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Button, Card, InlineError, Skeleton, Toggle } from '@/src/components/ds'
import type { AlarmGroup } from '@/src/components/Schedule/AlarmCard'
import { AlarmEditor } from '@/src/components/Schedule/AlarmEditor'
import { deleteAlarmMessage, groupAlarms } from '@/src/components/Schedule/AlarmSection'
import { ConfirmDialog } from '@/src/components/Schedule/ConfirmDialog'

import type { Side } from '@/src/providers/SideProvider'
import { trpc } from '@/src/utils/trpc'
import { pickAlarmGroup, summarizeDays } from './tempScreenUtils'
import { useNow } from './TonightCard'

/**
 * Next alarm for the side with an on/off toggle. Alarms sharing a time are one
 * group ("Weekdays · 10s buzz"); the toggle flips every day in the group.
 * Tapping the alarm edits it, and with none set, Add opens the same editor
 * as the Schedule page, with the same delete confirmation.
 *
 * Wires into schedules.getAll (alarm rows), schedules.updateAlarmSchedule and
 * schedules.batchUpdate (AlarmEditor saves, deletes).
 */
export function AlarmCard({ side }: { side: Side }) {
  const { formatTime } = useTimeFormatter()
  const utils = trpc.useUtils()
  const { data, isLoading, error } = trpc.schedules.getAll.useQuery({ side })
  const update = trpc.schedules.updateAlarmSchedule.useMutation()
  const batchUpdate = trpc.schedules.batchUpdate.useMutation()
  const now = useNow(60_000)
  // Keep the toggled group on screen after it turns off (otherwise the card
  // would jump to the next enabled alarm).
  const [pinnedTime, setPinnedTime] = useState<string | null>(null)
  const [pendingOn, setPendingOn] = useState<boolean | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  // The alarm the editor was opened on, kept until it closes: its saves
  // refetch, and the next alarm may then be a different one.
  const [editing, setEditing] = useState<AlarmGroup | null>(null)
  const [pendingDelete, setPendingDelete] = useState<AlarmGroup | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  if (isLoading) return <Skeleton className="h-[70px]" />

  const group = pickAlarmGroup(data?.alarm ?? [], now, pinnedTime)
  const on = pendingOn ?? group?.enabled ?? false
  // The editor works on Schedule-page groups (rows alike in every field).
  const editGroup = group
    ? groupAlarms(data?.alarm ?? []).find(g => g.ids.includes((group.rows.find(r => r.enabled) ?? group.rows[0]).id)) ?? null
    : null

  const openEditor = (target: AlarmGroup | null) => {
    setEditing(target)
    setEditorOpen(true)
  }

  const closeEditor = () => {
    setEditorOpen(false)
    setEditing(null)
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    setDeleteError(null)
    try {
      await batchUpdate.mutateAsync({ deletes: { alarm: pendingDelete.ids } })
      void utils.schedules.getAll.invalidate()
      void utils.schedules.getByDay.invalidate()
      setPendingDelete(null)
    }
    catch (err) {
      // Stays open to retry or cancel, as on the Schedule page.
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete alarm')
    }
  }

  const handleToggle = async (next: boolean) => {
    if (!group) return
    setPinnedTime(group.time)
    setPendingOn(next)
    const rows = next ? group.rows : group.rows.filter(r => r.enabled)
    try {
      await Promise.all(rows.map(r => update.mutateAsync({ id: r.id, enabled: next })))
    }
    catch {
      // update.error renders below; the refetch restores server truth.
    }
    finally {
      await utils.schedules.getAll.invalidate()
      setPendingOn(null)
    }
  }

  return (
    <Card className="flex-row items-center gap-2.5 py-3.5">
      <Bell size={16} className={cn('shrink-0', group && on ? 'text-warn' : 'text-fg-3')} />
      <div className="flex min-w-0 flex-col">
        {error
          ? <InlineError>{`Could not load alarms: ${error.message}`}</InlineError>
          : group
            ? (
                <button
                  type="button"
                  aria-label={`Edit ${formatTime(group.time)} alarm`}
                  onClick={() => openEditor(editGroup)}
                  className="flex min-w-0 cursor-pointer flex-col items-start bg-transparent p-0 text-left"
                >
                  <span className="font-mono text-sm">{formatTime(group.time)}</span>
                  <span className="truncate text-xs text-fg-2">
                    {`${summarizeDays(group.days)} · ${group.duration}s buzz`}
                  </span>
                </button>
              )
            : <span className="text-sm text-fg-2">No alarm set</span>}
        {update.error && <InlineError>{`Could not update alarm: ${update.error.message}`}</InlineError>}
      </div>
      {group
        ? (
            <Toggle
              className="ml-auto"
              on={on}
              label="Alarm enabled"
              disabled={update.isPending}
              onChange={next => void handleToggle(next)}
            />
          )
        : !error && (
            <Button icon={Plus} className="ml-auto" onClick={() => openEditor(null)}>
              Add
            </Button>
          )}
      <AlarmEditor
        open={editorOpen}
        onClose={closeEditor}
        side={side}
        existingGroup={editing}
        onSaved={() => { void utils.schedules.getAll.invalidate() }}
        onRequestDelete={(target) => {
          closeEditor()
          setPendingDelete(target)
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete alarm?"
        message={deleteAlarmMessage(pendingDelete?.days.length ?? 0, deleteError)}
        confirmLabel={deleteError ? 'Retry' : 'Delete'}
        variant="danger"
        busy={batchUpdate.isPending}
        onConfirm={() => void confirmDelete()}
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
      />
    </Card>
  )
}
