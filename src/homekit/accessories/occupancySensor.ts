/**
 * HomeKit OccupancySensor accessory bound to one Pod side.
 *
 * Reads from the shared virtual sensor (`src/lib/occupancy.ts`) so this
 * accessory, the web-app PresenceCard, and any future consumer
 * (MQTT/HA/iOS) all reflect the same state. See that module for the
 * movement + level signal combination.
 */

import { Service, Characteristic, HapStatusError } from 'hap-nodejs'
import { getOccupancy } from '@/src/lib/occupancy'
import { legacyPrivacyState } from '@/src/household/legacyPrivacy'
import type { Side } from '@/src/hardware/types'

const POLL_MS = 5_000

export interface OccupancyAccessory {
  service: Service
  stop: () => void
}

export function buildOccupancySensor(side: Side): OccupancyAccessory {
  const service = new Service.OccupancySensor(`Bed ${side} occupancy`, side)

  const characteristicValue = (): number => {
    // Apple Home is a shared audience. Withheld presence is unavailable, never
    // an empty-bed observation that could trigger an automation.
    if (legacyPrivacyState() !== 'legacy') throw new HapStatusError(-70402)
    const occupancy = getOccupancy(side)
    if (!occupancy.available) throw new HapStatusError(-70402)
    return occupancy.occupied
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
  }

  const update = (): void => {
    try {
      service.updateCharacteristic(Characteristic.OccupancyDetected, characteristicValue())
      service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.NO_FAULT)
    }
    catch {
      service.getCharacteristic(Characteristic.OccupancyDetected)
        .updateValue(new HapStatusError(-70402))
      service.updateCharacteristic(Characteristic.StatusFault, Characteristic.StatusFault.GENERAL_FAULT)
    }
  }

  service.getCharacteristic(Characteristic.OccupancyDetected).onGet(characteristicValue)

  update()
  const handle = setInterval(update, POLL_MS)
  handle.unref?.()

  return {
    service,
    stop: () => clearInterval(handle),
  }
}
