/**
 * HomeKit Switch that triggers pod priming.
 * Auto-flips off when getPrimeCompletedAt() resolves OR after 6 min as a watchdog.
 */

import { Service, Characteristic } from 'hap-nodejs'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { getPrimeCompletedAt } from '@/src/hardware/primeNotification'

const POLL_MS = 5_000
const WATCHDOG_MS = 6 * 60 * 1000

export interface PrimeSwitchAccessory {
  service: Service
  stop: () => void
}

export function buildPrimeSwitch(): PrimeSwitchAccessory {
  const service = new Service.Switch('Prime pod', 'prime')
  let baseline = getPrimeCompletedAt()
  let watchdog: ReturnType<typeof setTimeout> | null = null
  // Tracks the perceived state. hap-nodejs reads onGet on every controller
  // poll regardless of updateCharacteristic, so the handler must reflect the
  // same state the polling loop is pushing — otherwise iOS sees the switch
  // bounce back to off the next read.
  let on = false

  const setOn = (next: boolean): void => {
    on = next
    service.updateCharacteristic(Characteristic.On, next)
  }

  service.getCharacteristic(Characteristic.On)
    .onGet(() => on)
    .onSet(async (value) => {
      if (Number(value) !== 1) {
        setOn(false)
        return
      }
      try {
        baseline = getPrimeCompletedAt()
        await getSharedHardwareClient().startPriming()
        setOn(true)
        if (watchdog) clearTimeout(watchdog)
        watchdog = setTimeout(() => setOn(false), WATCHDOG_MS)
        watchdog.unref?.()
      }
      catch (e) {
        setOn(false)
        throw e
      }
    })

  const handle = setInterval(() => {
    const completedAt = getPrimeCompletedAt()
    if (completedAt != null && completedAt !== baseline) {
      baseline = completedAt
      setOn(false)
      if (watchdog) {
        clearTimeout(watchdog)
        watchdog = null
      }
    }
  }, POLL_MS)
  handle.unref?.()

  return {
    service,
    stop: () => {
      clearInterval(handle)
      if (watchdog) clearTimeout(watchdog)
    },
  }
}
