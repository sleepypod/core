'use client'

import clsx from 'clsx'
import { useSide } from '@/src/hooks/useSide'

/**
 * Simple left/right side selector for schedule context.
 * Uses the global useSide hook backed by localStorage.
 */
export function ScheduleSideSelector() {
  const { side, setSide } = useSide()

  return (
    <div className="flex rounded-xl bg-zinc-900 p-1">
      <button
        onClick={() => setSide('left')}
        className={clsx(
          'flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors',
          side === 'left'
            ? 'bg-zinc-800 text-sky-400'
            : 'text-zinc-500 active:text-zinc-300'
        )}
      >
        Left Side
      </button>
      <button
        onClick={() => setSide('right')}
        className={clsx(
          'flex-1 rounded-lg py-2.5 text-sm font-medium transition-colors',
          side === 'right'
            ? 'bg-zinc-800 text-sky-400'
            : 'text-zinc-500 active:text-zinc-300'
        )}
      >
        Right Side
      </button>
    </div>
  )
}
