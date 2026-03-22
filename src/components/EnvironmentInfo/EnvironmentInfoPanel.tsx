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
    <div className="flex items-stretch justify-center gap-3 rounded-2xl bg-zinc-900 p-2 sm:gap-4 sm:p-3">
      {/* Home/Inside Temperature */}
      {ambientTemp != null && ambientTemp > 0 && (
        <InfoItem
          icon={<Home size={14} />}
          label="Inside"
          value={formatTemp(ambientTemp, unit)}
        />
      )}

      {/* Auto-off Timer (only shown when active) */}
      {secondsRemaining != null && secondsRemaining > 0 && (
        <>
          {ambientTemp != null && ambientTemp > 0 && <Divider />}
          <InfoItem
            icon={<Timer size={14} />}
            label="Auto-off"
            value={formatTimeRemaining(secondsRemaining)}
          />
        </>
      )}
    </div>
  )
}

const InfoItem = ({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) => (
  <div className="flex min-w-0 flex-1 flex-col items-center gap-0.5 sm:gap-1">
    <div className="flex items-center gap-0.5 text-zinc-500 sm:gap-1">
      {icon}
      <span className="truncate text-[9px] font-medium uppercase tracking-wider sm:text-[10px]">{label}</span>
    </div>
    <span className="text-[13px] font-semibold text-zinc-200 sm:text-sm">{value}</span>
  </div>
)

const Divider = () => (
  <div className="w-px self-stretch bg-zinc-800" />
)
