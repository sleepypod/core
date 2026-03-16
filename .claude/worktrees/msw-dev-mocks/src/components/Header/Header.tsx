import { PowerButton } from '@/src/components/PowerButton/PowerButton'
import { WifiSignalStrength } from '@/src/components/WifiSignalStrength/WifiSignalStrength'
import styles from './Header.module.css'

/**
 * Global header component for the application.
 * Displays WiFi status and power button.
 */
export const Header = () => {
  return (
    <header className={styles.header}>
      <WifiSignalStrength signalStrength={75} />
      <PowerButton />
    </header>
  )
}
