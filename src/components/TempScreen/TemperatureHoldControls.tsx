'use client'

import { CalendarDays, Hand, ShieldAlert, Sparkles, Timer } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { SelectValue } from '@/src/components/ds'
import { trpc } from '@/src/utils/trpc'
import type { Side } from '@/src/hardware/types'
import type { TemperatureControlStatus } from '@/src/temperature/controller'

export const HOLD_OPTIONS: ReadonlyArray<{ value: number, label: string }> = [
  { value: 15, label: '15 min' },
  { value: 30, label: '30 min' },
  { value: 60, label: '1 hr' },
  { value: 120, label: '2 hr' },
]

const formatClock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** Who currently owns the side's temperature (PR #727 ownership model). */
export function ownershipLabel(control: TemperatureControlStatus): { icon: LucideIcon, text: string, danger?: boolean } {
  if (control.blocked === 'safety') return { icon: ShieldAlert, text: 'Safety stop', danger: true }
  if (control.blocked === 'off') return { icon: Hand, text: 'Off' }
  switch (control.source) {
    case 'schedule': return { icon: CalendarDays, text: 'On schedule' }
    case 'autopilot': return { icon: Sparkles, text: 'Autopilot' }
    case 'run-once': return { icon: Timer, text: 'Run-once session' }
    case 'manual': return {
      icon: Hand,
      text: control.holdUntil != null ? `Manual hold · until ${formatClock(control.holdUntil)}` : 'Manual hold',
    }
    default: return { icon: Hand, text: 'Manual' }
  }
}

/**
 * Mono ownership line for one side ("ON SCHEDULE", "MANUAL HOLD · UNTIL 11:45 PM")
 * with Resume while a manual hold is active. `prefix` renders before it (phone
 * shows "LEFT · IN BED" on the same line).
 */
export function HoldStatus({ side, control, prefix, onResumed }: {
  side: Side
  control: TemperatureControlStatus | undefined
  prefix?: ReactNode
  onResumed: () => void
}) {
  const resume = trpc.device.resumeTemperature.useMutation({ onSuccess: onResumed })
  const owner = control ? ownershipLabel(control) : null
  const Icon = owner?.icon
  return (
    <div className="flex flex-col gap-1.5">
      <div className="sp-label flex min-h-[18px] items-center gap-1.5">
        {prefix}
        {owner && Icon && (
          <span className={cn('flex min-w-0 items-center gap-1.5 max-[899px]:ml-auto', owner.danger && 'text-danger')}>
            <Icon size={12} className="shrink-0" />
            <span className="truncate">{owner.text}</span>
          </span>
        )}
        {control?.holdUntil != null && (
          <button
            type="button"
            className="ml-auto shrink-0 cursor-pointer rounded-tag border-0 bg-transparent px-1 font-mono text-[11px] uppercase tracking-[0.06em] text-fg hover:bg-active disabled:cursor-default disabled:opacity-45 max-[899px]:ml-2"
            disabled={resume.isPending}
            onClick={() => resume.mutate({ side })}
          >
            Resume
          </button>
        )}
      </div>
      {resume.error && (
        <p role="alert" className="text-[13px] text-danger">
          Could not resume:
          {' '}
          {resume.error.message}
        </p>
      )}
    </div>
  )
}

/** "Hold after adjustment" row — duration applied to the next manual change. */
export function HoldDurationRow({ holdMinutes, onDurationChange }: {
  holdMinutes: number
  onDurationChange: (minutes: number) => void
}) {
  return (
    <div className="mt-auto flex items-center gap-3 border-t border-line pt-3 text-sm text-fg-2 min-[900px]:text-[13px]">
      Hold after adjustment
      <SelectValue
        className="ml-auto"
        label="Temperature hold duration"
        value={holdMinutes}
        options={HOLD_OPTIONS}
        onChange={v => onDurationChange(v)}
      />
    </div>
  )
}
