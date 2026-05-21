'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { Moon, Plane, Settings } from 'lucide-react'
import { useSide } from '@/src/providers/SideProvider'
import { useSideNames } from '@/src/hooks/useSideNames'
import { trpc } from '@/src/utils/trpc'
import styles from './Header.module.css'

function isInNightWindow(start: string, end: string, timezone: string): boolean {
  const [sH, sM] = start.split(':').map(Number)
  const [eH, eM] = end.split(':').map(Number)
  if ([sH, sM, eH, eM].some(n => Number.isNaN(n))) return false

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date())
  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? '0')
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? '0')

  const now = hour * 60 + minute
  const startMin = sH * 60 + sM
  const endMin = eH * 60 + eM
  return startMin <= endMin
    ? now >= startMin && now < endMin
    : now >= startMin || now < endMin
}

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
    && isInNightWindow(device.ledNightStartTime, device.ledNightEndTime, device.timezone),
  )
  void nightTick

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
        {isNight && (
          <span className="flex items-center gap-1 rounded-full bg-indigo-500/15 px-2 py-0.5 text-[10px] font-semibold text-indigo-300">
            <Moon size={10} />
            Night
          </span>
        )}
      </div>
      <Link
        href="/en/settings"
        className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-zinc-400 transition-colors active:bg-zinc-800"
        aria-label="Settings"
      >
        <Settings size={18} />
      </Link>
    </header>
  )
}
