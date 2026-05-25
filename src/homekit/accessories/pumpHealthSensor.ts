/**
 * HomeKit LeakSensor accessory bound to the pump stall guard's per-side
 * notification state.
 *
 * Picks LeakSensor (not Fan or generic sensor) because Home renders it as a
 * red alert tile when triggered, which matches the safety surface the
 * pump-stall guard provides. RPM itself isn't exposed — a number with no
 * setpoint context is meaningless to a Home-app user.
 *
 * Poll cadence is faster than the ambient sensor because this is a safety
 * signal — a 60s lag would noticeably delay automation responses.
 */

import { Service, Characteristic } from 'hap-nodejs'
import { getPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import type { Side } from '@/src/hardware/types'

const POLL_MS = 5_000

export interface PumpHealthSensorAccessory {
  service: Service
  stop: () => void
}

export function buildPumpHealthSensor(side: Side): PumpHealthSensorAccessory {
  const label = side === 'left' ? 'Pod pump left' : 'Pod pump right'
  const service = new Service.LeakSensor(label, `pump-${side}`)
  let stalled = false

  service.getCharacteristic(Characteristic.LeakDetected)
    .onGet(() => (
      stalled
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED
    ))

  const refresh = (): void => {
    const next = getPumpStallNotice(side) != null
    if (next === stalled) return
    stalled = next
    service.updateCharacteristic(
      Characteristic.LeakDetected,
      stalled
        ? Characteristic.LeakDetected.LEAK_DETECTED
        : Characteristic.LeakDetected.LEAK_NOT_DETECTED,
    )
  }
  refresh()
  const handle = setInterval(refresh, POLL_MS)
  handle.unref()

  return {
    service,
    stop: () => clearInterval(handle),
  }
}
