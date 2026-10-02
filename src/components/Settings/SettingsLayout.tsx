'use client'

import { CheckCircle2, Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Two stacked card columns when the content area has room (container query on
 * the AppShell <main>), one column otherwise — left column first.
 */
export function SectionColumns({ left, right, className }: {
  left: ReactNode
  right?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('grid items-start gap-3.5 @min-[800px]:grid-cols-2', className)}>
      <div className="flex min-w-0 flex-col gap-3.5">{left}</div>
      {right && <div className="flex min-w-0 flex-col gap-3.5">{right}</div>}
    </div>
  )
}

/** Native time picker dressed as the mono value chip. Value is "HH:MM". */
export function TimeField({ value, onChange, label, disabled, className }: {
  value: string
  onChange: (v: string) => void
  label: string
  disabled?: boolean
  className?: string
}) {
  return (
    <input
      type="time"
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={e => onChange(e.target.value)}
      className={cn(
        'min-w-0 cursor-pointer appearance-none rounded-ctl border border-line-2 bg-transparent px-2.5 py-1.5 font-mono text-[13px] text-fg outline-none focus:border-fg-3 disabled:cursor-default disabled:opacity-45',
        className,
      )}
    />
  )
}

/** Compact mono number input for threshold-style settings. */
export function NumberField({ value, onChange, onBlur, min, max, step, label, disabled }: {
  value: number
  onChange: (v: number) => void
  onBlur?: () => void
  min?: number
  max?: number
  step?: number
  label: string
  disabled?: boolean
}) {
  return (
    <input
      type="number"
      aria-label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={e => onChange(Number(e.target.value))}
      onBlur={onBlur}
      className="w-24 rounded-ctl border border-line-2 bg-field px-2.5 py-1.5 text-right font-mono text-[13px] text-fg outline-none focus:border-fg-3 disabled:opacity-45"
    />
  )
}

/** Floating "Saving… / Saved" pill for auto-saving forms. */
export function SaveToast({ pending, saved }: { pending: boolean, saved: boolean }) {
  const show = pending || saved
  return (
    <div
      aria-live="polite"
      className={cn(
        'pointer-events-none fixed inset-x-0 bottom-[calc(96px+env(safe-area-inset-bottom,0px))] z-50 flex justify-center px-4 transition-opacity duration-150 min-[900px]:bottom-8',
        show ? 'opacity-100' : 'opacity-0',
      )}
    >
      <div className="flex items-center gap-2 rounded-full border border-line-2 bg-surface px-3 py-1.5 text-xs text-fg">
        {pending
          ? (
              <>
                <Loader2 size={12} className="animate-spin text-fg-2" />
                Saving…
              </>
            )
          : saved
            ? (
                <>
                  <CheckCircle2 size={12} className="text-ok" />
                  Saved
                </>
              )
            : null}
      </div>
    </div>
  )
}
