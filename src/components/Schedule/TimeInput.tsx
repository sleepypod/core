'use client'

import { useTimeFormat } from '@/src/providers/PrefsProvider'
import { Clock } from 'lucide-react'
import { useId, type ReactNode } from 'react'
import { calcDuration, formatTime12h } from '@/src/lib/scheduleTime'

export { calcDuration, formatTime12h }

interface TimeInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  hideLabel?: boolean
  /** Optional icon shown next to the label */
  icon?: ReactNode
  /** Tailwind text-color class for the icon and label accent */
  accentClass?: string
}

/**
 * Touch-friendly time input with HH:MM format.
 * Uses the native picker in 12-hour mode and explicit hour/minute selects
 * in 24-hour mode, independent of the browser/OS picker locale.
 *
 * The native picker indicator is stretched over the whole field (invisible)
 * so a tap anywhere opens the picker. Browsers give that indicator its own
 * margin/padding, which pushed it ~14px past the field and made the
 * surrounding scroll container (the alarm editor) scroll sideways on
 * mobile — so it's zeroed, the wrapper clips, and appearance-none keeps iOS
 * Safari from sizing the input by its native width.
 */
export function TimeInput({ label, value, onChange, disabled = false, hideLabel = false, icon, accentClass }: TimeInputProps) {
  const id = useId()
  const timeFormat = useTimeFormat()
  const [hour = '00', minute = '00'] = (value || '00:00').split(':')
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'flex items-center gap-1.5 truncate text-xs text-fg-2'}>
        {icon && <span className={accentClass}>{icon}</span>}
        {label}
      </label>
      <div className="relative min-w-0 overflow-hidden rounded-ctl">
        {timeFormat === '24h'
          ? (
              <div className="flex h-[38px] items-center rounded-ctl border border-line-2 bg-field px-2 pr-9 font-mono text-[13px]">
                <select
                  id={id}
                  aria-label={`${label} hours`}
                  value={hour}
                  disabled={disabled}
                  onChange={e => onChange(`${e.target.value}:${minute}`)}
                  className="min-w-0 flex-1 bg-field text-fg disabled:opacity-45"
                >
                  {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')).map(h => <option key={h} value={h}>{h}</option>)}
                </select>
                <span aria-hidden>:</span>
                <select
                  aria-label={`${label} minutes`}
                  value={minute}
                  disabled={disabled}
                  onChange={e => onChange(`${hour}:${e.target.value}`)}
                  className="min-w-0 flex-1 bg-field text-fg disabled:opacity-45"
                >
                  {Array.from({ length: 60 }, (_, m) => String(m).padStart(2, '0')).map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            )
          : (
              <input
                id={id}
                type="time"
                value={value}
                onChange={e => onChange(e.target.value)}
                disabled={disabled}
                className="block h-[38px] w-full min-w-0 appearance-none rounded-ctl border border-line-2 bg-field px-3 pr-9 font-mono text-[13px] text-fg outline-none transition-colors focus:border-fg-3 disabled:cursor-not-allowed disabled:opacity-45 [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:m-0 [&::-webkit-calendar-picker-indicator]:p-0 [&::-webkit-calendar-picker-indicator]:cursor-pointer"
              />
            )}
        <Clock size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-fg-3" />
      </div>
    </div>
  )
}
