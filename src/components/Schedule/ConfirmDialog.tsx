'use client'

import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { Button, Modal } from '@/src/components/ds'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  /** Disables the confirm button and shows a spinner while the action runs. */
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Confirmation dialog (Dialog on desktop, Sheet on phones). Used for
 * destructive actions like deleting a curve or an alarm.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      width={480}
      footer={(
        <div className="ml-auto flex gap-2.5">
          <Button onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={variant === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} disabled={busy}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {confirmLabel}
          </Button>
        </div>
      )}
    >
      <p className="text-sm leading-[1.5] text-fg-2 text-pretty">{message}</p>
    </Modal>
  )
}
