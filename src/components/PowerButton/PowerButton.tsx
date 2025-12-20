import { Power } from "lucide-react"
import styles from "./PowerButton.module.css"

/**
 *  A circular power button component with a power icon.
 **/
export const PowerButton = () => {
  return (
    <button className={styles.powerButton}>
      <Power size={20} />
    </button>
  )
}