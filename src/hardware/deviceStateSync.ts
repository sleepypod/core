import { eq } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { sleepRecords } from '@/src/db/biometrics-schema'
import type { DeviceStatus } from './types'

/**
 * Consumes status:updated events and writes current device state to the DB.
 * Also detects power transitions to create stub sleep records.
 * No hardware access. No business logic beyond power-transition tracking.
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
   *   ON→OFF: creates a stub sleep record and clears poweredOnAt
   *
   * The SELECT and UPSERT run inside a single transaction so concurrent
   * sync() calls cannot both observe the same ON→OFF transition and
   * double-create a sleep record.
   */
  private upsertSide = async (side: 'left' | 'right', status: DeviceStatus): Promise<void> => {
    const sideStatus = side === 'left' ? status.leftSide : status.rightSide
    const now = new Date()
    const isNowPowered = sideStatus.currentLevel !== 0

    const sleepInfo = await db.transaction(async (tx) => {
      const [prev] = await tx
        .select({ isPowered: deviceState.isPowered, poweredOnAt: deviceState.poweredOnAt })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)

      const wasPowered = prev?.isPowered ?? false
      let poweredOnAt = prev?.poweredOnAt ?? null
      let sessionToRecord: { enteredBedAt: Date, leftBedAt: Date } | null = null

      if (!wasPowered && isNowPowered) {
        // OFF → ON: record when the session started
        poweredOnAt = now
      }
      else if (wasPowered && !isNowPowered && poweredOnAt) {
        // ON → OFF: capture timestamps; write to biometricsDb after commit
        sessionToRecord = { enteredBedAt: poweredOnAt, leftBedAt: now }
        poweredOnAt = null
      }

      await tx
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

      return sessionToRecord
    })

    // Write to biometricsDb after the main transaction commits — it's a
    // separate SQLite file so it cannot share the transaction, but the
    // deviceState row is already updated so a retry would not re-trigger this.
    if (sleepInfo) {
      await this.createSleepRecord(side, sleepInfo.enteredBedAt, sleepInfo.leftBedAt)
    }
  }

  /**
   * Create a stub sleep record from power on/off timestamps.
   * presentIntervals and timesExitedBed are left empty — a future biometrics
   * module will backfill these with accurate presence data.
   */
  private createSleepRecord = async (
    side: 'left' | 'right',
    enteredBedAt: Date,
    leftBedAt: Date
  ): Promise<void> => {
    const sleepDurationSeconds = Math.round((leftBedAt.getTime() - enteredBedAt.getTime()) / 1000)
    // Ignore sessions shorter than 5 minutes (noise / accidental power cycles)
    if (sleepDurationSeconds < 300) return

    try {
      await biometricsDb.insert(sleepRecords).values({
        side,
        enteredBedAt,
        leftBedAt,
        sleepDurationSeconds,
        timesExitedBed: 0,
        presentIntervals: null,
        notPresentIntervals: null,
      })
      console.log(`Sleep record created for ${side}: ${Math.round(sleepDurationSeconds / 60)} min`)
    }
    catch (error) {
      console.error(
        'DeviceStateSync: failed to create sleep record:',
        error instanceof Error ? error.message : error
      )
    }
  }
}
