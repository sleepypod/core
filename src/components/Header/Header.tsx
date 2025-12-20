import { WifiSignalStrength } from '@/src/components/WifiSignalStrength/WifiSignalStrength'
import { Power } from 'lucide-react'
import styles from './Header.module.css'

/**
 * Global header component for the application.
 * Displays WiFi status and power button.
 */
export const Header = () => {
  return (
    <header className={styles.header}>
      <WifiSignalStrength signalStrength={75} />

      <button className={styles.powerButton}>
        <Power size={20} />
      </button>
    </header>
  )
}
