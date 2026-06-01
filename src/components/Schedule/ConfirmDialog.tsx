'use client'

interface ConfirmDialogProps {
  open: boolean
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  onConfirm: () => void
  onCancel: () => void
}

/**
 * Lightweight confirmation modal. Used for destructive actions like
 * deleting a curve.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  if (!open) return null

  const confirmClass = variant === 'danger'
    ? 'bg-red-500 active:bg-red-600'
    : 'bg-sky-500 active:bg-sky-600'

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl bg-zinc-900 p-5">
        <h3 className="text-sm font-semibold text-white">{title}</h3>
        <p className="mt-2 text-xs text-zinc-400">{message}</p>
        <div className="mt-4 flex gap-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-xl border border-zinc-700 px-3 py-2 text-xs font-medium text-zinc-300 active:bg-zinc-800"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className={`flex-1 rounded-xl px-3 py-2 text-xs font-semibold text-white ${confirmClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
