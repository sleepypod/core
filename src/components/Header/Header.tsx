'use client'

import { Plane, Settings } from 'lucide-react'
import { useSide } from '@/src/providers/SideProvider'
import { useSideNames } from '@/src/hooks/useSideNames'
import { trpc } from '@/src/utils/trpc'
import styles from './Header.module.css'

/**
 * Global header — shows the active user name with a tappable settings icon.
 * Displays an "Away" chip when the active side's away mode is enabled.
 */
export const Header = () => {
  const { primarySide } = useSide()
  const { sideName } = useSideNames()
  const { data: settings } = trpc.settings.getAll.useQuery({}, { staleTime: 30_000 })

  const sideSettings = primarySide === 'left' ? settings?.sides?.left : settings?.sides?.right
  const isAway = sideSettings?.awayMode ?? false

  return (
    <header className={styles.header}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-zinc-400">{sideName(primarySide)}</span>
        {isAway && (
          <span className="flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-400">
            <Plane size={10} />
            Away
          </span>
        )}
      </div>
      <a
        href="/en/settings"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-zinc-400 transition-colors active:bg-zinc-800"
        aria-label="Settings"
      >
        <Settings size={18} />
      </a>
    </header>
  )
}
