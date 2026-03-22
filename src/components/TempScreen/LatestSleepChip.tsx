'use client'

import { Moon } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

/**
 * Compact "last night" sleep summary shown on the Temp screen.
 * Shows sleep duration from the most recent sleep record.
 *
 * Wires into:
 * - biometrics.getLatestSleep → most recent sleep record for active side
 */
export function LatestSleepChip() {
  const { primarySide } = useSide()

  const { data: latest } = trpc.biometrics.getLatestSleep.useQuery(
    { side: primarySide },
    { refetchInterval: 60_000, staleTime: 30_000 },
  )

  if (!latest) return null

  return (
    <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
      <Moon size={12} className="text-indigo-400" />
      <span>
        Last night:
        {formatDuration(latest.sleepDurationSeconds)}
      </span>
    </div>
  )
}
