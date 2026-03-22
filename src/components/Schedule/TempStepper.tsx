'use client'

import { Minus, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { colorForTempF } from '@/src/lib/sleepCurve/tempColor'

interface TempStepperProps {
  label: string
  icon: React.ReactNode
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  accentClass?: string
}

/**
 * Temperature stepper with +/- buttons.
 * Color-coded indicator dot reflects the current temperature.
 */
export function TempStepper({
  label,
  icon,
  value,
  onChange,
  min = 55,
  max = 110,
  step = 1,
  accentClass = 'text-zinc-400',
}: TempStepperProps) {
  const canDecrease = value > min
  const canIncrease = value < max

  return (
    <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="flex items-center gap-2">
        <span
          className="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: colorForTempF(value) }}
        />
        <div className={cn('flex items-center gap-1.5 text-sm font-medium', accentClass)}>
          {icon}
          <span>{label}</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => canDecrease && onChange(value - step)}
          disabled={!canDecrease}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-30"
          aria-label={`Decrease ${label}`}
        >
          <Minus size={14} />
        </button>
        <span className="w-12 text-center font-mono text-base font-semibold text-white tabular-nums">
          {value}
          °F
        </span>
        <button
          type="button"
          onClick={() => canIncrease && onChange(value + step)}
          disabled={!canIncrease}
          className="flex h-11 w-11 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 transition-colors hover:bg-zinc-700 disabled:opacity-30"
          aria-label={`Increase ${label}`}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  )
}
