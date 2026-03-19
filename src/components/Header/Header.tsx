'use client'

import { PowerButton } from '@/src/components/PowerButton/PowerButton'
import { WifiSignalStrength } from '@/src/components/WifiSignalStrength/WifiSignalStrength'
import { trpc } from '@/src/utils/trpc'
import styles from './Header.module.css'

/**
 * Global header component for the application.
 * Displays live WiFi status (via tRPC) and power button.
 */
export const Header = () => {
  const { data: wifi } = trpc.system.wifiStatus.useQuery(
    {},
    { refetchInterval: 10_000 },
  )

  return (
    <header className={styles.header}>
      <WifiSignalStrength signalStrength={wifi?.connected ? (wifi.signal ?? 0) : 0} />
      <PowerButton />
    </header>
  )
}
