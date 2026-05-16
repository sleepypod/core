/**
 * HomeKit OccupancySensor accessory bound to one Pod side.
 *
 * Occupancy is derived from the `movement` table rather than `sleep_records`:
 * a `sleep_records` row is only inserted at session close (and `leftBedAt` is
 * NOT NULL by schema), so there is no queryable "session-open" signal. The
 * `movement` table is updated every 60s with a baseline-subtracted score
 * (~0 on an empty bed, >=50 when an occupant is moving — see docs/sleep-
 * detector.md PIM scoring).
 *
 * Rule: OCCUPIED iff any movement epoch in the last MOVEMENT_WINDOW_MS has
 * total_movement >= RESTLESS_SCORE_MIN. The 15-minute window tolerates the
 * 70-80% of deep-sleep epochs that score below the threshold.
 */

import { Service, Characteristic } from 'hap-nodejs'
import { and, eq, gte, sql } from 'drizzle-orm'
import { biometricsDb } from '@/src/db/biometrics'
import { movement } from '@/src/db/biometrics-schema'
import { RESTLESS_SCORE_MIN } from '@/src/lib/movement'
import type { Side } from '@/src/hardware/types'

const POLL_MS = 5_000
const MOVEMENT_WINDOW_MS = 15 * 60_000

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
    const since = new Date(Date.now() - MOVEMENT_WINDOW_MS)
    const [row] = biometricsDb
      .select({ peak: sql<number>`MAX(${movement.totalMovement})` })
      .from(movement)
      .where(and(eq(movement.side, side), gte(movement.timestamp, since)))
      .limit(1)
      .all()
    const peak = row?.peak ?? 0
    return peak >= RESTLESS_SCORE_MIN
  }
  catch {
    return false
  }
}
