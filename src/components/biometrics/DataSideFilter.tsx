'use client'

import clsx from 'clsx'
import { Users, User } from 'lucide-react'
import { useSide, type SideSelection } from '@/src/providers/SideProvider'

type DataFilter = 'both' | 'left' | 'right'

const FILTERS: { value: DataFilter; label: string; icon?: typeof Users }[] = [
  { value: 'both', label: 'Both', icon: Users },
  { value: 'left', label: 'Left', icon: User },
  { value: 'right', label: 'Right', icon: User },
]

/**
 * Side-selection toggle for the Data screen header.
 *
 * Provides both/left-only/right-only filtering that controls which
 * series are visible in all chart views. Uses the global SideProvider
 * context which already supports 'both' | 'left' | 'right'.
 *
 * Matches iOS dual-side comparison toggle pattern.
 */
export function DataSideFilter() {
  const { selectedSide, selectSide } = useSide()

  return (
    <div className="flex items-center rounded-xl bg-zinc-900 p-0.5">
      {FILTERS.map(({ value, label, icon: Icon }) => {
        const isActive = selectedSide === value
        return (
          <button
            key={value}
            onClick={() => selectSide(value as SideSelection)}
            className={clsx(
              'flex items-center gap-1 rounded-lg px-3 py-1.5 text-[11px] font-medium transition-all duration-150',
              isActive
                ? 'bg-zinc-700 text-sky-400 shadow-sm'
                : 'text-zinc-500 active:text-zinc-300',
            )}
            aria-pressed={isActive}
            aria-label={`Show ${label.toLowerCase()} side data`}
          >
            {Icon && (
              <Icon
                size={12}
                className={clsx(
                  'transition-colors duration-150',
                  isActive ? 'text-sky-400' : 'text-zinc-600',
                )}
              />
            )}
            {label}
          </button>
        )
      })}
    </div>
  )
}
