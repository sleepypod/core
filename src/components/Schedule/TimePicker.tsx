'use client'

import { useCallback, useMemo } from 'react'
import { minutesToTimeStr, timeStringToMinutes } from '@/src/lib/sleepCurve/generate'

interface TimePickerProps {
  /** Label shown above the picker */
  label: string
  /** Icon component to render */
  icon: React.ReactNode
  /** Accent color class (e.g. 'text-purple-400') */
  accentClass: string
  /** Current time as HH:mm string */
  value: string
  /** Callback when time changes — receives HH:mm string */
  onChange: (time: string) => void
}

/**
 * Time picker optimized for mobile — uses native HTML time input
 * styled within the dark theme. Shows 12h display but stores 24h.
 */
export function TimePicker({ label, icon, accentClass, value, onChange }: TimePickerProps) {
  const displayTime = useMemo(() => {
    const mins = timeStringToMinutes(value)
    const h = Math.floor(mins / 60)
    const m = mins % 60
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${String(m).padStart(2, '0')} ${period}`
  }, [value])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value
      if (newValue) {
        // Ensure it's properly formatted
        const mins = timeStringToMinutes(newValue)
        onChange(minutesToTimeStr(mins))
      }
    },
    [onChange],
  )

  return (
    <div className="flex flex-1 flex-col items-center gap-1.5">
      <div className={`flex items-center gap-1.5 text-xs font-medium ${accentClass}`}>
        {icon}
        <span>{label}</span>
      </div>
      <label className="relative cursor-pointer">
        <div className="rounded-lg border border-zinc-700 bg-zinc-800/60 px-4 py-2.5 min-h-[44px] flex items-center justify-center text-center text-base font-semibold tabular-nums text-white transition-colors hover:border-zinc-600">
          {displayTime}
        </div>
        <input
          type="time"
          value={value}
          onChange={handleChange}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label={label}
        />
      </label>
    </div>
  )
}
