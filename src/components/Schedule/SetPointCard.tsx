'use client'

import { Minus, Plus, Trash2 } from 'lucide-react'
import clsx from 'clsx'
import type { SchedulePhase } from '@/src/hooks/useSchedules'
import { formatTime12h } from './TimeInput'
import { colorForTempF } from '@/src/lib/sleepCurve/tempColor'

interface SetPointCardProps {
  phase: SchedulePhase
  onAdjustTemp: (id: number, delta: number) => void
  onDelete: (id: number) => void
  onTapCard: (phase: SchedulePhase) => void
  disabled?: boolean
}

/**
 * Vertical set point row — time, colored temp, +/- controls, delete.
 */
export function SetPointCard({
  phase,
  onAdjustTemp,
  onDelete,
  onTapCard,
  disabled = false,
}: SetPointCardProps) {
  const tempColor = colorForTempF(phase.temperature)

  return (
    <div
      className={clsx(
        'flex items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900 px-3 py-2.5 transition-opacity',
        !phase.enabled && 'opacity-40',
        disabled && 'opacity-60',
      )}
      onClick={() => {
        if (!disabled) onTapCard(phase)
      }}
      role="button"
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          onTapCard(phase)
        }
      }}
    >
      {/* Time */}
      <div className="min-w-[60px]">
        <span className="text-sm font-medium text-zinc-300">
          {formatTime12h(phase.time)}
        </span>
      </div>

      {/* Temp indicator dot + value */}
      <div className="flex items-center gap-1.5">
        <span
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: tempColor }}
        />
        <span className="text-sm font-bold tabular-nums text-white">
          {phase.temperature}
          °
        </span>
      </div>

      {/* Phase name */}
      <span className="text-xs text-zinc-500">{phase.name}</span>

      {/* Spacer */}
      <div className="flex-1" />

      {/* +/- controls */}
      <div className="flex items-center gap-0" onClick={e => e.stopPropagation()}>
        <button
          onClick={() => onAdjustTemp(phase.id, -2)}
          disabled={disabled || phase.temperature <= 55}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors active:text-zinc-200 disabled:opacity-30"
          aria-label="Decrease temperature"
        >
          <Minus size={12} strokeWidth={3} />
        </button>
        <button
          onClick={() => onAdjustTemp(phase.id, 2)}
          disabled={disabled || phase.temperature >= 110}
          className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors active:text-zinc-200 disabled:opacity-30"
          aria-label="Increase temperature"
        >
          <Plus size={12} strokeWidth={3} />
        </button>
      </div>

      {/* Delete */}
      <button
        onClick={(e) => {
          e.stopPropagation()
          onDelete(phase.id)
        }}
        disabled={disabled}
        className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors active:text-red-400 disabled:opacity-30"
        aria-label={`Delete ${phase.name}`}
      >
        <Trash2 size={12} />
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
 * Vertical list of set point rows.
 */
export function SetPointList({
  phases,
  onAdjustTemp,
  onDelete,
  onTapCard,
  disabled = false,
}: SetPointListProps) {
  return (
    <div className="space-y-1.5">
      {phases.map(phase => (
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
  )
}
