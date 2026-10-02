'use client'

import type { LucideIcon } from 'lucide-react'
import { TriangleAlert, X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/* ─── Modal ────────────────────────────────────────────────────────────────
   One component, two presentations switched by viewport width (900px):
   a centered Dialog on desktop, a bottom Sheet on phones. Same body. */
export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  icon?: LucideIcon
  iconClassName?: string
  headerRight?: ReactNode
  footer?: ReactNode
  /** Desktop dialog width in px (480–560 per spec). */
  width?: number
  children: ReactNode
  className?: string
}

export function Modal({ open, onClose, title, icon: Icon, iconClassName, headerRight, footer, width = 520, children, className }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      className="sp-fade-in fixed inset-0 z-50 flex flex-col justify-end bg-[var(--overlay)] min-[900px]:items-center min-[900px]:justify-center min-[900px]:p-10"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        onClick={e => e.stopPropagation()}
        className={cn(
          'flex max-h-[94dvh] w-full flex-col gap-4 overflow-auto bg-surface text-fg',
          // Sheet (phone)
          'rounded-t-sheet border-t border-line-2 px-5 pb-[calc(14px+env(safe-area-inset-bottom,0px))] pt-2.5',
          // Dialog (desktop)
          'min-[900px]:max-h-full min-[900px]:w-[var(--dlg-w)] min-[900px]:max-w-full min-[900px]:rounded-dialog min-[900px]:border min-[900px]:px-6 min-[900px]:py-[22px] min-[900px]:shadow-[var(--shadow-dialog)]',
          className,
        )}
        style={{ ['--dlg-w' as string]: `${width}px` }}
      >
        <div className="h-[5px] w-10 shrink-0 self-center rounded-[3px] bg-line-2 min-[900px]:hidden" />
        <div className="flex items-center gap-2.5">
          {Icon && <Icon size={18} className={iconClassName} />}
          <span className="text-[17px] font-medium">{title}</span>
          <div className="ml-auto flex items-center gap-3">
            {headerRight}
            <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer border-0 bg-transparent p-0 text-fg-2 hover:text-fg">
              <X size={18} />
            </button>
          </div>
        </div>
        {children}
        {footer && (
          <div className="flex flex-wrap items-center gap-2.5 min-[900px]:border-t min-[900px]:border-line min-[900px]:pt-3.5">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/* ─── Alert ──────────────────────────────────────────────────────────── */
export function Alert({ tone = 'warn', children, onDismiss, action, className }: {
  tone?: 'warn' | 'danger'
  children: ReactNode
  onDismiss?: () => void
  action?: ReactNode
  className?: string
}) {
  const danger = tone === 'danger'
  return (
    <div
      role="status"
      className={cn(
        'flex items-center gap-2.5 rounded-ctl px-3 py-2.5',
        danger ? 'border border-danger-line bg-transparent' : 'bg-warn-bg',
        className,
      )}
    >
      <TriangleAlert size={14} className={cn('shrink-0', danger ? 'text-danger' : 'text-warn')} />
      <span className={cn('flex-1 text-[13px]', danger ? 'text-danger' : 'text-warn')}>{children}</span>
      {action}
      {onDismiss && (
        <button type="button" aria-label="Dismiss" onClick={onDismiss} className="cursor-pointer border-0 bg-transparent p-0 text-fg-2">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
