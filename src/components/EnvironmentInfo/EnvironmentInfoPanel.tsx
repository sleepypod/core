'use client'

import { Droplets, Home, Snowflake, Thermometer, Timer } from 'lucide-react'
import { trpc } from '@/src/utils/trpc'
import { useSide } from '@/src/providers/SideProvider'
import { formatTemp, type TempUnit } from '@/src/lib/tempUtils'

interface EnvironmentInfoProps {
  /** Seconds remaining from auto-off timer, if available */
  secondsRemaining?: number | null
  /** Temperature unit preference */
  unit?: TempUnit
}

/**
 * Horizontal info bar showing environment data:
 * - Ambient temperature (from bed temp sensor)
 * - Humidity
 * - Bed surface temperature (left/right center)
 * - Auto-off timer countdown
 *
 * Matches iOS EnvironmentInfoView layout.
 */
export const EnvironmentInfoPanel = ({ secondsRemaining, unit = 'F' }: EnvironmentInfoProps) => {
  const { primarySide } = useSide()

  const { data: bedTemp } = trpc.environment.getLatestBedTemp.useQuery(
    { unit },
    { refetchInterval: 10_000 },
  )

  const { data: freezerTemp } = trpc.environment.getLatestFreezerTemp.useQuery(
    { unit },
    { refetchInterval: 10_000 },
  )

  // Ambient temp comes from bed temp sensor
  const ambientTemp = bedTemp?.ambientTemp
  const humidity = bedTemp?.humidity

  // Bed surface temp — use center sensor for the primary side
  const bedSurfaceTemp = primarySide === 'left'
    ? bedTemp?.leftCenterTemp
    : bedTemp?.rightCenterTemp

  // Water temperature from freezer unit for the primary side
  const waterTemp = primarySide === 'left'
    ? freezerTemp?.leftWaterTemp
    : freezerTemp?.rightWaterTemp

  const formatTimeRemaining = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    return `${minutes}m`
  }

  return (
    <div className="flex items-stretch justify-center gap-3 rounded-2xl bg-zinc-900 p-2 sm:gap-4 sm:p-3">
      {/* Bed Surface Temperature — the inside temp */}
      <InfoItem
        icon={<Thermometer size={14} />}
        label="Bed"
        value={bedSurfaceTemp != null ? formatTemp(bedSurfaceTemp, unit) : '--'}
      />

      {/* Auto-off Timer (only shown when active) */}
      {secondsRemaining != null && secondsRemaining > 0 && (
        <>
          <Divider />
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
