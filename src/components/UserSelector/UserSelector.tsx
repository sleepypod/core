'use client'

import clsx from 'clsx'
import { User } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide, type SideSelection } from '@/src/providers/SideProvider'

/**
 * User/side selector that shows configured names from DB side_settings.
 * Displays left/right buttons with user names (e.g. "Nick", "Partner")
 * and an optional "Both" mode when sides are linked.
 */
export const UserSelector = () => {
  const { selectedSide, selectSide, isLinked, toggleLink } = useSide()
  const { data: settings } = trpc.settings.getAll.useQuery({})

  const leftName = settings?.sides?.left?.name ?? 'Left'
  const rightName = settings?.sides?.right?.name ?? 'Right'

  const handleSideSelect = (side: SideSelection) => {
    if (side === selectedSide && side !== 'both') return
    selectSide(side)
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Side buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => handleSideSelect('left')}
          className={clsx(
            'flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 sm:px-4 sm:py-3 sm:text-sm',
            selectedSide === 'left' || selectedSide === 'both'
              ? 'bg-zinc-800 text-white border border-sky-500/30'
              : 'bg-zinc-900 text-zinc-500 border border-transparent',
          )}
        >
          <User size={16} />
          <span>{leftName}</span>
        </button>

        {/* Link toggle */}
        <button
          onClick={toggleLink}
          className={clsx(
            'flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-all duration-200',
            isLinked
              ? 'bg-sky-500/20 text-sky-400'
              : 'bg-zinc-900 text-zinc-600',
          )}
          aria-label={isLinked ? 'Unlink sides' : 'Link sides'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
              d="M6.5 9.5L9.5 6.5M5.5 11.5L4 13C3.17 13.83 1.83 13.83 1 13 .17 12.17.17 10.83 1 10L4 7C4.83 6.17 6.17 6.17 7 7M9 9C9.83 9.83 11.17 9.83 12 9L15 6C15.83 5.17 15.83 3.83 15 3 14.17 2.17 12.83 2.17 12 3L10.5 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>

        <button
          onClick={() => handleSideSelect('right')}
          className={clsx(
            'flex flex-1 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-medium transition-all duration-200 sm:px-4 sm:py-3 sm:text-sm',
            selectedSide === 'right' || selectedSide === 'both'
              ? 'bg-zinc-800 text-white border border-sky-500/30'
              : 'bg-zinc-900 text-zinc-500 border border-transparent',
          )}
        >
          <User size={16} />
          <span>{rightName}</span>
        </button>
      </div>
    </div>
  )
}
