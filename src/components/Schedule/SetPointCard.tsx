'use client'

import { Moon, Sun, Sunrise, Minus, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { SchedulePhase, PhaseIcon } from '@/src/hooks/useSchedules'
import { formatTime12h } from './TimeInput'

const ICON_MAP: Record<PhaseIcon, typeof Moon> = {
  moon: Moon,
  sunrise: Sunrise,
  sun: Sun,
}

/**
 * Get temperature color based on offset from neutral (80°F).
 * Cool = blue, Neutral = zinc, Warm = amber/orange.
 */
function getTempColor(temp: number): { text: string; border: string; bg: string } {
  if (temp <= 68) return { text: 'text-sky-400', border: 'border-sky-500/20', bg: 'bg-sky-500/10' }
  if (temp <= 74) return { text: 'text-sky-300', border: 'border-sky-400/20', bg: 'bg-sky-400/10' }
  if (temp <= 80) return { text: 'text-zinc-400', border: 'border-zinc-600/30', bg: 'bg-zinc-700/20' }
  if (temp <= 88) return { text: 'text-amber-400', border: 'border-amber-500/20', bg: 'bg-amber-500/10' }
  return { text: 'text-orange-400', border: 'border-orange-500/20', bg: 'bg-orange-500/10' }
}

interface SetPointCardProps {
  phase: SchedulePhase
  onAdjustTemp: (id: number, delta: number) => void
  onDelete: (id: number) => void
  onTapCard: (phase: SchedulePhase) => void
  disabled?: boolean
}

/**
 * Compact set point card matching iOS PhaseBlockCompactView.
 * Shows phase icon, name, time, and +/- temperature controls.
 * Long-press or tap opens edit mode, swipe-to-delete via trash button.
 */
export function SetPointCard({
  phase,
  onAdjustTemp,
  onDelete,
  onTapCard,
  disabled = false,
}: SetPointCardProps) {
  const Icon = ICON_MAP[phase.icon] ?? Sun
  const color = getTempColor(phase.temperature)

  return (
    <div
      className={clsx(
        'relative flex w-[100px] shrink-0 flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 sm:w-[110px] sm:gap-2 sm:py-3',
        'bg-zinc-900 transition-opacity',
        color.border,
        !phase.enabled && 'opacity-40',
        disabled && 'pointer-events-none'
      )}
      onClick={() => onTapCard(phase)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onTapCard(phase) }}
    >
      {/* Icon */}
      <Icon size={16} className={color.text} />

      {/* Phase name */}
      <span className="text-[10px] font-semibold text-white leading-tight text-center">
        {phase.name}
      </span>

      {/* Time */}
      <span className="text-[9px] text-zinc-500">
        {formatTime12h(phase.time)}
      </span>

      {/* Temperature controls */}
      <div className="flex items-center gap-0" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => onAdjustTemp(phase.id, -2)}
          disabled={phase.temperature <= 55}
          className="flex min-h-[44px] min-w-[32px] items-center justify-center text-zinc-400 transition-colors active:text-zinc-200 disabled:opacity-30"
          aria-label="Decrease temperature"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800">
            <Minus size={10} strokeWidth={3} />
          </span>
        </button>

        <span className={clsx('min-w-[36px] text-center text-sm font-bold tabular-nums', color.text)}>
          {phase.temperature}°
        </span>

        <button
          onClick={() => onAdjustTemp(phase.id, 2)}
          disabled={phase.temperature >= 110}
          className="flex min-h-[44px] min-w-[32px] items-center justify-center text-zinc-400 transition-colors active:text-zinc-200 disabled:opacity-30"
          aria-label="Increase temperature"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-zinc-800">
            <Plus size={10} strokeWidth={3} />
          </span>
        </button>
      </div>

      {/* Delete button (small, top-right corner) */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete(phase.id)
        }}
        className="absolute -right-3 -top-3 flex h-8 w-8 items-center justify-center rounded-full bg-zinc-800 text-zinc-500 opacity-60 transition-opacity hover:opacity-100 focus:opacity-100 active:opacity-100 active:text-red-400"
        aria-label={`Delete ${phase.name}`}
      >
        <Trash2 size={10} />
      </button>
    </div>
  )
}

interface SetPointListProps {
  phases: SchedulePhase[]
  onAdjustTemp: (id: number, delta: number) => void
  onDelete: (id: number) => void
  onTapCard: (phase: SchedulePhase) => void
  disabled?: boolean
}

/**
 * Horizontal scrolling list of SetPointCards, matching iOS horizontal ScrollView.
 */
export function SetPointList({
  phases,
  onAdjustTemp,
  onDelete,
  onTapCard,
  disabled = false,
}: SetPointListProps) {
  return (
    <div className="group -mx-1 overflow-x-auto scrollbar-none">
      <div className="flex gap-2.5 px-1 py-1">
        {phases.map((phase) => (
          <SetPointCard
            key={phase.id}
            phase={phase}
            onAdjustTemp={onAdjustTemp}
            onDelete={onDelete}
            onTapCard={onTapCard}
            disabled={disabled}
          />
        ))}
      </div>
    </div>
  )
}
