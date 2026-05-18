/**
 * HomeKit OccupancySensor accessory bound to one Pod side.
 *
 * Reads from the shared virtual sensor (`src/lib/occupancy.ts`) so this
 * accessory, the web-app PresenceCard, and any future consumer
 * (MQTT/HA/iOS) all reflect the same state. See that module for the
 * movement + level signal combination.
 */

import { Service, Characteristic } from 'hap-nodejs'
import { getOccupancy } from '@/src/lib/occupancy'
import type { Side } from '@/src/hardware/types'

const POLL_MS = 5_000

export interface OccupancyAccessory {
  service: Service
  stop: () => void
}

export function buildOccupancySensor(side: Side): OccupancyAccessory {
  const service = new Service.OccupancySensor(`Bed ${side} occupancy`, side)

  const characteristicValue = (): number => (
    getOccupancy(side).occupied
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
  )

  const update = (): void => {
    service.updateCharacteristic(Characteristic.OccupancyDetected, characteristicValue())
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
