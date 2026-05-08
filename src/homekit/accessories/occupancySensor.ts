/**
 * HomeKit OccupancySensor accessory bound to one Pod side.
 * Sourced from biometrics: latest sleep_records row with leftBedAt IS NULL.
 */

import { Service, Characteristic } from 'hap-nodejs'
import { desc, eq } from 'drizzle-orm'
import { biometricsDb } from '@/src/db/biometrics'
import { sleepRecords } from '@/src/db/biometrics-schema'
import type { Side } from '@/src/hardware/types'

const POLL_MS = 5_000

export interface OccupancyAccessory {
  service: Service
  stop: () => void
}

export function buildOccupancySensor(side: Side): OccupancyAccessory {
  const service = new Service.OccupancySensor(`Bed ${side} occupancy`, side)

  const update = (): void => {
    const present = readPresence(side)
    const value = present
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED
    service.updateCharacteristic(Characteristic.OccupancyDetected, value)
  }

  service.getCharacteristic(Characteristic.OccupancyDetected)
    .onGet(() => readPresence(side)
      ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
      : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED,
    )

  update()
  const handle = setInterval(update, POLL_MS)
  handle.unref?.()

  return {
    service,
    stop: () => clearInterval(handle),
  }
}

function readPresence(side: Side): boolean {
  try {
    const [latest] = biometricsDb
      .select({ leftBedAt: sleepRecords.leftBedAt })
      .from(sleepRecords)
      .where(eq(sleepRecords.side, side))
      .orderBy(desc(sleepRecords.enteredBedAt))
      .limit(1)
      .all()
    if (!latest) return false
    return latest.leftBedAt == null
  }
  catch {
    return false
  }
}
