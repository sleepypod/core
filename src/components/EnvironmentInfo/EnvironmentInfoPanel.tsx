'use client'

import { Home, Timer } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { formatTemp, type TempUnit } from '@/src/lib/tempUtils'

interface EnvironmentInfoProps {
  /** Seconds remaining from auto-off timer, if available */
  secondsRemaining?: number | null
  /** Temperature unit preference */
  unit?: TempUnit
}

/**
 * Horizontal info bar showing environment data.
 * Matches iOS EnvironmentInfoView layout:
 * - Home/inside temperature (ambient sensor)
 * - Auto-off timer countdown (when active)
 */
export const EnvironmentInfoPanel = ({ secondsRemaining, unit = 'F' }: EnvironmentInfoProps) => {
  const { data: bedTemp } = trpc.environment.getLatestBedTemp.useQuery(
    { unit },
    { refetchInterval: 10_000 },
  )

  // Ambient/room temp comes from bed temp sensor
  const ambientTemp = bedTemp?.ambientTemp

  const formatTimeRemaining = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  if (ambientTemp == null && !(secondsRemaining != null && secondsRemaining > 0)) {
    return null
  }

  return (
    <div className="flex items-center justify-center gap-4 mt-6">
      {/* Home/Inside Temperature — inline: icon + temp + "Inside" */}
      {ambientTemp != null && ambientTemp > 0 && (
        <div className="flex items-center gap-2 text-zinc-500">
          <Home size={18} />
          <span className="text-sm">{formatTemp(ambientTemp, unit)}</span>
          <span className="text-sm">Inside</span>
        </div>
      )}

      {/* Auto-off Timer */}
      {secondsRemaining != null && secondsRemaining > 0 && (
        <div className="flex items-center gap-2 text-zinc-500">
          <Timer size={18} />
          <span className="text-sm">{formatTimeRemaining(secondsRemaining)}</span>
        </div>
      )}
    </div>
  )
}
