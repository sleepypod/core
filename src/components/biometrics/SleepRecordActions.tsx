'use client'

import { useState, useCallback } from 'react'
import { trpc } from '@/src/utils/trpc'
import { Pencil, Trash2, X, Loader2, Check } from 'lucide-react'

interface SleepRecordActionsProps {
  recordId: number
  enteredBedAt: Date
  leftBedAt: Date
  onActionComplete?: () => void
}

function formatDateTimeLocal(date: Date): string {
  const d = new Date(date)
  // Format to datetime-local input value
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Inline actions for editing/deleting a sleep record.
 * Matches iOS sleep record management functionality.
 *
 * Wires into:
 * - biometrics.updateSleepRecord → edit bed/wake times
 * - biometrics.deleteSleepRecord → remove record
 */
export function SleepRecordActions({
  recordId,
  enteredBedAt,
  leftBedAt,
  onActionComplete,
}: SleepRecordActionsProps) {
  const [mode, setMode] = useState<'idle' | 'edit' | 'confirmDelete'>('idle')
  const [editBedTime, setEditBedTime] = useState(formatDateTimeLocal(enteredBedAt))
  const [editWakeTime, setEditWakeTime] = useState(formatDateTimeLocal(leftBedAt))

  const utils = trpc.useUtils()

  const updateMutation = trpc.biometrics.updateSleepRecord.useMutation({
    onSuccess: () => {
      utils.biometrics.getSleepRecords.invalidate()
      utils.biometrics.getLatestSleep.invalidate()
      setMode('idle')
      onActionComplete?.()
    },
  })

  const deleteMutation = trpc.biometrics.deleteSleepRecord.useMutation({
    onSuccess: () => {
      utils.biometrics.getSleepRecords.invalidate()
      utils.biometrics.getLatestSleep.invalidate()
      setMode('idle')
      onActionComplete?.()
    },
  })

  const handleSave = useCallback(() => {
    updateMutation.mutate({
      id: recordId,
      enteredBedAt: new Date(editBedTime),
      leftBedAt: new Date(editWakeTime),
    })
  }, [recordId, editBedTime, editWakeTime, updateMutation])

  const handleDelete = useCallback(() => {
    deleteMutation.mutate({ id: recordId })
  }, [recordId, deleteMutation])

  const isPending = updateMutation.isPending || deleteMutation.isPending

  if (mode === 'idle') {
    return (
      <div className="flex items-center gap-1">
        <button
          onClick={() => setMode('edit')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-600 active:bg-zinc-800 active:text-zinc-400"
          title="Edit sleep record"
        >
          <Pencil size={12} />
        </button>
        <button
          onClick={() => setMode('confirmDelete')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-600 active:bg-zinc-800 active:text-red-400"
          title="Delete sleep record"
        >
          <Trash2 size={12} />
        </button>
      </div>
    )
  }

  if (mode === 'confirmDelete') {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-red-400">Delete?</span>
        <button
          onClick={handleDelete}
          disabled={isPending}
          className="flex h-8 items-center gap-1 rounded-lg bg-red-900/30 px-2 text-[10px] font-semibold text-red-400 active:bg-red-900/50 disabled:opacity-50"
        >
          {deleteMutation.isPending ? <Loader2 size={10} className="animate-spin" /> : 'Yes'}
        </button>
        <button
          onClick={() => setMode('idle')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800"
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  // Edit mode
  return (
    <div className="mt-2 space-y-2 rounded-lg bg-zinc-800/50 p-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] text-zinc-500">Bedtime</label>
          <input
            type="datetime-local"
            value={editBedTime}
            onChange={(e) => setEditBedTime(e.target.value)}
            className="w-full rounded-md bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:ring-1 focus:ring-sky-500"
          />
        </div>
        <div>
          <label className="text-[9px] text-zinc-500">Wake</label>
          <input
            type="datetime-local"
            value={editWakeTime}
            onChange={(e) => setEditWakeTime(e.target.value)}
            className="w-full rounded-md bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 outline-none focus:ring-1 focus:ring-sky-500"
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {(updateMutation.isError || deleteMutation.isError) && (
          <span className="flex-1 text-[9px] text-red-400">
            {updateMutation.error?.message ?? deleteMutation.error?.message}
          </span>
        )}
        <button
          onClick={() => setMode('idle')}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 active:bg-zinc-800"
        >
          <X size={12} />
        </button>
        <button
          onClick={handleSave}
          disabled={isPending}
          className="flex h-8 items-center gap-1 rounded-lg bg-sky-600 px-3 text-[10px] font-semibold text-white active:bg-sky-700 disabled:opacity-50"
        >
          {updateMutation.isPending ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            <Check size={10} />
          )}
          Save
        </button>
      </div>
    </div>
  )
}
