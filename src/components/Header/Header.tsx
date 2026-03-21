'use client'

import { useState } from 'react'
import { Settings } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'
import styles from './Header.module.css'

/**
 * Global header — shows the active user name with a tappable profile icon.
 * Tapping opens the Settings page (similar to iOS ProfileAndSettingsSheet).
 */
export const Header = () => {
  const { primarySide } = useSide()
  const { data: settings } = trpc.settings.getAll.useQuery({})

  const userName = primarySide === 'left'
    ? (settings?.sides?.left?.name ?? 'Left')
    : (settings?.sides?.right?.name ?? 'Right')

  return (
    <header className={styles.header}>
      <span className="text-sm font-medium text-zinc-400">{userName}</span>
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
