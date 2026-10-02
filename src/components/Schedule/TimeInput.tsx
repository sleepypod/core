'use client'

import { Clock } from 'lucide-react'
import { useId, type ReactNode } from 'react'
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
 *
 * The native picker indicator is stretched over the whole field (invisible)
 * so a tap anywhere opens the picker. Browsers give that indicator its own
 * margin/padding, which pushed it ~14px past the field and made the
 * surrounding scroll container (the alarm editor) scroll sideways on
 * mobile — so it's zeroed, the wrapper clips, and appearance-none keeps iOS
 * Safari from sizing the input by its native width.
 */
export function TimeInput({ label, value, onChange, disabled = false, icon, accentClass }: TimeInputProps) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="flex items-center gap-1.5 truncate text-xs text-fg-2">
        {icon && <span className={accentClass}>{icon}</span>}
        {label}
      </label>
      <div className="relative min-w-0 overflow-hidden rounded-ctl">
        <input
          id={id}
          type="time"
          value={value}
          onChange={e => onChange(e.target.value)}
          disabled={disabled}
          className="block h-[38px] w-full min-w-0 appearance-none rounded-ctl border border-line-2 bg-field px-3 pr-9 font-mono text-[13px] text-fg outline-none transition-colors focus:border-fg-3 disabled:cursor-not-allowed disabled:opacity-45 [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:p-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
        />
        <Clock size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-3" />
      </div>
    </div>
  )
}
