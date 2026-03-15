import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import type { DeviceStatus } from './types'

/**
 * Consumes status:updated events and writes current device state to the DB.
 * Tracks power transitions (OFF→ON stamps poweredOnAt, ON→OFF clears it).
 *
 * Sleep records are handled exclusively by the sleep-detector module, which
 * uses capacitance sensor data for accurate presence detection rather than
 * power-cycle heuristics.
 */
export class DeviceStateSync {
  sync = async (status: DeviceStatus): Promise<void> => {
    try {
      await Promise.all([
        this.upsertSide('left', status),
        this.upsertSide('right', status),
      ])
    }
    catch (error) {
      console.error(
        'DeviceStateSync: failed to write device_state:',
        error instanceof Error ? error.message : error
      )
    }
  }

  /**
   * Upsert one side of device_state from a fresh DeviceStatus.
   * Detects OFF→ON and ON→OFF transitions:
   *   OFF→ON: stamps poweredOnAt
   *   ON→OFF: clears poweredOnAt
   */
  private upsertSide = async (side: 'left' | 'right', status: DeviceStatus): Promise<void> => {
    const sideStatus = side === 'left' ? status.leftSide : status.rightSide
    const now = new Date()
    const isNowPowered = sideStatus.currentLevel !== 0

    db.transaction((tx) => {
      const [prev] = tx
        .select({ isPowered: deviceState.isPowered, poweredOnAt: deviceState.poweredOnAt })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()

      const wasPowered = prev?.isPowered ?? false
      let poweredOnAt = prev?.poweredOnAt ?? null

      if (!wasPowered && isNowPowered) {
        poweredOnAt = now
      }
      else if (wasPowered && !isNowPowered) {
        poweredOnAt = null
      }

      tx
        .insert(deviceState)
        .values({
          side,
          currentTemperature: sideStatus.currentTemperature,
          targetTemperature: sideStatus.targetTemperature,
          isPowered: isNowPowered,
          waterLevel: status.waterLevel,
          poweredOnAt,
          lastUpdated: now,
        })
        .onConflictDoUpdate({
          target: deviceState.side,
          set: {
            currentTemperature: sideStatus.currentTemperature,
            targetTemperature: sideStatus.targetTemperature,
            isPowered: isNowPowered,
            waterLevel: status.waterLevel,
            poweredOnAt,
            lastUpdated: now,
          },
        })
        .run()
    })
  }
}
