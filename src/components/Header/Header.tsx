'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState } from 'react'
import { Moon, Plane, Settings } from 'lucide-react'
import { useSide } from '@/src/providers/SideProvider'
import { useSideNames } from '@/src/hooks/useSideNames'
import { trpc } from '@/src/utils/trpc'
import { isInWindowForTimezone } from '@/src/lib/scheduleTime'
import styles from './Header.module.css'

/**
 * Global header — shows the active user name with a tappable settings icon.
 * Displays an "Away" chip when the active side's away mode is enabled, and a
 * "Night" chip when LED night mode is currently in its time window.
 */
export const Header = () => {
  const { primarySide } = useSide()
  const { sideName } = useSideNames()
  const { data: settings } = trpc.settings.getAll.useQuery({}, { staleTime: 30_000 })

  const sideSettings = primarySide === 'left' ? settings?.sides?.left : settings?.sides?.right
  const isAway = sideSettings?.awayMode ?? false

  // On the desktop diagnostics console the side indicator and Settings live in
  // the console's left menu, so the global toolbar drops them there at md+.
  const pathname = usePathname()
  const onDebug = (pathname?.split('/')[2] ?? '') === 'debug'

  const device = settings?.device
  const [nightTick, setNightTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNightTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
  const isNight = Boolean(
    device?.ledNightModeEnabled
    && device.ledNightStartTime
    && device.ledNightEndTime
    && isInWindowForTimezone(device.ledNightStartTime, device.ledNightEndTime, device.timezone),
  )
  void nightTick

  return (
    <header className={styles.header}>
      <div className="flex items-center gap-2">
        <span className={`text-sm font-medium text-zinc-400 ${onDebug ? 'md:hidden' : ''}`}>{sideName(primarySide)}</span>
        {isAway && (
          <span className="flex items-center gap-1 rounded-full bg-sky-500/15 px-2 py-0.5 text-[10px] font-semibold text-sky-400">
            <Plane size={10} />
            Away
          </span>
        )}
        {isNight && (
          <span className="flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
            <Moon size={10} />
            Night
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Link
          href="/en/settings"
          className={`flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-zinc-400 transition-colors active:bg-zinc-800 ${onDebug ? 'md:hidden' : ''}`}
          aria-label="Settings"
        >
          <Settings size={18} />
        </Link>
      </div>
    </header>
  )
}
