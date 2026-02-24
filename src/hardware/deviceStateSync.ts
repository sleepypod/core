import { db } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import type { DeviceStatus } from './types'

/**
 * Consumes status:updated events and writes current device state to the DB.
 * No hardware access. No business logic. Sync only.
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
   * `isPowered` is derived as `currentLevel !== 0` — the hardware has no
   * explicit power flag in DEVICE_STATUS.
   */
  private upsertSide = async (side: 'left' | 'right', status: DeviceStatus): Promise<void> => {
    const sideStatus = side === 'left' ? status.leftSide : status.rightSide
    const now = new Date()

    await db
      .insert(deviceState)
      .values({
        side,
        currentTemperature: sideStatus.currentTemperature,
        targetTemperature: sideStatus.targetTemperature,
        isPowered: sideStatus.currentLevel !== 0,
        waterLevel: status.waterLevel,
        lastUpdated: now,
      })
      .onConflictDoUpdate({
        target: deviceState.side,
        set: {
          currentTemperature: sideStatus.currentTemperature,
          targetTemperature: sideStatus.targetTemperature,
          isPowered: sideStatus.currentLevel !== 0,
          waterLevel: status.waterLevel,
          lastUpdated: now,
        },
      })
  }
}
