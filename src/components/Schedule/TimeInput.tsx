'use client'

import { Clock } from 'lucide-react'

interface TimeInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
}

/**
 * Touch-friendly time input with HH:MM format.
 * Uses native time input for mobile pickers.
 */
export function TimeInput({ label, value, onChange, disabled = false }: TimeInputProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs font-medium text-zinc-400">{label}</label>
      <div className="relative">
        <input
          type="time"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className="h-11 w-full rounded-lg border border-zinc-700 bg-zinc-800/50 px-3 pr-9 text-sm font-medium text-white outline-none transition-colors focus:border-sky-500 disabled:cursor-not-allowed disabled:opacity-40 [&::-webkit-calendar-picker-indicator]:opacity-0 [&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:inset-0 [&::-webkit-calendar-picker-indicator]:w-full [&::-webkit-calendar-picker-indicator]:h-full [&::-webkit-calendar-picker-indicator]:cursor-pointer"
        />
        <Clock size={16} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-zinc-500" />
      </div>
    </div>
  )
}

/**
 * Format HH:MM to 12-hour display string.
 */
export function formatTime12h(time: string): string {
  const [hourStr, minuteStr] = time.split(':')
  const hour = parseInt(hourStr, 10)
  const minute = minuteStr ?? '00'
  if (isNaN(hour)) return time
  const period = hour >= 12 ? 'PM' : 'AM'
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour
  return `${displayHour}:${minute} ${period}`
}

/**
 * Calculate duration between two HH:MM times (handles overnight).
 */
export function calcDuration(onTime: string, offTime: string): string {
  const [onH, onM] = onTime.split(':').map(Number)
  const [offH, offM] = offTime.split(':').map(Number)
  if (isNaN(onH) || isNaN(onM) || isNaN(offH) || isNaN(offM)) return '—'
  let totalMinutes = (offH * 60 + offM) - (onH * 60 + onM)
  if (totalMinutes < 0) totalMinutes += 24 * 60
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  return `${hours}h ${mins}m`
}
