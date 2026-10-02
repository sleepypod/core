'use client'

import { useCallback, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { Button, InlineError, Modal, TextField } from '@/src/components/ds'

interface SleepRecordActionsProps {
  recordId: number
  enteredBedAt: Date
  /** null while the session is still open (occupant in bed). */
  leftBedAt: Date | null
  onActionComplete?: () => void
}

export function formatDateTimeLocal(date: Date): string {
  const d = new Date(date)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * "Edit times" for a sleep record: a dialog (sheet on phones) to correct
 * bed/wake times or delete the record.
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
  const [open, setOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editBedTime, setEditBedTime] = useState('')
  const [editWakeTime, setEditWakeTime] = useState('')

  const utils = trpc.useUtils()
  const onSuccess = () => {
    utils.biometrics.getSleepRecords.invalidate()
    utils.biometrics.getLatestSleep.invalidate()
    utils.biometrics.getSleepStages.invalidate()
    setOpen(false)
    onActionComplete?.()
  }
  const updateMutation = trpc.biometrics.updateSleepRecord.useMutation({ onSuccess })
  const deleteMutation = trpc.biometrics.deleteSleepRecord.useMutation({ onSuccess })

  const openEditor = useCallback(() => {
    setEditBedTime(formatDateTimeLocal(enteredBedAt))
    setEditWakeTime(leftBedAt ? formatDateTimeLocal(leftBedAt) : '')
    setConfirmDelete(false)
    updateMutation.reset()
    deleteMutation.reset()
    setOpen(true)
  }, [enteredBedAt, leftBedAt, updateMutation, deleteMutation])

  const handleSave = useCallback(() => {
    updateMutation.mutate({
      id: recordId,
      enteredBedAt: new Date(editBedTime),
      ...(editWakeTime ? { leftBedAt: new Date(editWakeTime) } : {}),
    })
  }, [recordId, editBedTime, editWakeTime, updateMutation])

  const handleDelete = useCallback(() => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    deleteMutation.mutate({ id: recordId })
  }, [confirmDelete, recordId, deleteMutation])

  const isPending = updateMutation.isPending || deleteMutation.isPending
  const errorMessage = updateMutation.error?.message ?? deleteMutation.error?.message

  return (
    <>
      <button
        type="button"
        onClick={openEditor}
        aria-label="Edit times"
        className="flex cursor-pointer items-center gap-1.5 rounded-ctl border-0 bg-transparent px-1.5 py-1 text-[13px] text-fg-2 hover:bg-active hover:text-fg"
      >
        <Pencil size={14} />
        <span className="max-[899px]:hidden">Edit times</span>
      </button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Edit sleep record"
        width={480}
        footer={(
          <>
            <Button variant="danger" icon={Trash2} onClick={handleDelete} disabled={isPending}>
              {confirmDelete ? 'Confirm delete' : 'Delete'}
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={isPending || !editBedTime}>
              {updateMutation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        )}
      >
        <div className="grid grid-cols-1 gap-3 min-[900px]:grid-cols-2">
          <TextField label="Bedtime" type="datetime-local" value={editBedTime} onChange={setEditBedTime} />
          <TextField label="Wake" type="datetime-local" value={editWakeTime} onChange={setEditWakeTime} />
        </div>
        {confirmDelete && <p className="text-[13px] text-fg-2">Deleting removes this night from Sleep. This cannot be undone.</p>}
        {errorMessage && <InlineError>{errorMessage}</InlineError>}
      </Modal>
    </>
  )
}
