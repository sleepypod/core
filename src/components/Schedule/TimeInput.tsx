'use client'

import { Clock } from 'lucide-react'
import type { ReactNode } from 'react'
import { calcDuration, formatTime12h } from '@/src/lib/scheduleTime'

export { calcDuration, formatTime12h }

interface TimeInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  /** Optional icon shown next to the label */
  icon?: ReactNode
  /** Tailwind text-color class for the icon and label accent */
  accentClass?: string
}

/**
 * Touch-friendly time input with HH:MM format.
 * Uses native time input for mobile pickers.
 */
export function TimeInput({ label, value, onChange, disabled = false, icon, accentClass }: TimeInputProps) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label className="flex items-center gap-1.5 truncate text-xs font-medium text-zinc-400">
        {icon && <span className={accentClass}>{icon}</span>}
        {label}
      </label>
      <div className="relative min-w-0">
        <input
          type="time"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className="h-11 w-full min-w-0 rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 pr-9 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
        />
        <Clock size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500" />
      </div>
    </div>
  )
}
