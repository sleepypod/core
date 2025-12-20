import { Trans } from '@lingui/react/macro'
import clsx from 'clsx'
import { Wifi, WifiOff } from 'lucide-react'

interface WifiSignalStrengthProps {
  signalStrength?: number
}

/**
 * Determine the CSS class based on signal strength
 **/
const getStatusClass = (strength: number | null): string => {
  if (strength === null) return 'text-red-400' // disconnected
  if (strength < 30) return 'text-red-400' // weak
  if (strength < 60) return 'text-yellow-400' // medium

  return 'text-teal-400' // strong
}

/**
 * Displays the current signal strength of the WiFi connection.
 * If no strength is provided, an error state is shown.
 */
export const WifiSignalStrength = ({ signalStrength = 0 }: WifiSignalStrengthProps) => {
  const normalizedStrength = Math.max(0, Math.min(100, Math.round(signalStrength)))

  const statusClass = getStatusClass(normalizedStrength)

  return (
    <div className={clsx('flex items-center gap-1.5 text-[#4ecdc4] text-sm font-medium', statusClass)}>
      {signalStrength
        ? (
            <>
              <Wifi size={18} className={statusClass} />
              <span className="text-white">
                {normalizedStrength}
                %
              </span>
            </>
          )
        : (
            <>
              <WifiOff size={18} className={statusClass} />
              <span className={statusClass}>
                <Trans>Offline</Trans>
              </span>
            </>
          )}
    </div>
  )
}
