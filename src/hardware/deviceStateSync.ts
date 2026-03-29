import { eq } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { waterLevelReadings, flowReadings } from '@/src/db/biometrics-schema'
import type { DeviceStatus } from './types'

/**
 * Consumes status:updated events and writes current device state to the DB.
 * Tracks power transitions (OFF→ON stamps poweredOnAt, ON→OFF clears it).
 *
 * Sleep records are handled exclusively by the sleep-detector module, which
 * uses capacitance sensor data for accurate presence detection rather than
 * power-cycle heuristics.
 */
/** Read alarm vibration state from DB (set by setAlarm/clearAlarm mutations). */
export function getAlarmState(): { left: boolean, right: boolean } {
  try {
    const rows = db
      .select({ side: deviceState.side, isAlarmVibrating: deviceState.isAlarmVibrating })
      .from(deviceState)
      .all()
    const left = rows.find(r => r.side === 'left')?.isAlarmVibrating ?? false
    const right = rows.find(r => r.side === 'right')?.isAlarmVibrating ?? false
    return { left, right }
  }
  catch (error) {
    console.error('getAlarmState: failed to read alarm state from DB, falling back to false:', error instanceof Error ? error.message : error)
    return { left: false, right: false }
  }
}

export class DeviceStateSync {
  private lastWaterLevelWrite = 0
  private lastFlowWrite = 0

  sync = async (status: DeviceStatus): Promise<void> => {
    this.recordWaterLevel(status)
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

  /** Write water level to biometrics DB, rate-limited to once per 60s. */
  private recordWaterLevel(status: DeviceStatus): void {
    const now = Date.now()
    if (now - this.lastWaterLevelWrite < 60_000) return

    const level = status.waterLevel === 'low' ? 'low' as const : 'ok' as const
    try {
      biometricsDb
        .insert(waterLevelReadings)
        .values({ timestamp: new Date(now), level })
        .run()
      this.lastWaterLevelWrite = now
    }
    catch (error) {
      console.error('DeviceStateSync: failed to write water level:', error instanceof Error ? error.message : error)
    }
  }

  /** Write flow/pump data to biometrics DB, rate-limited to once per 60s. */
  recordFlowData(frzHealth: {
    left: { pump: { rpm: number }, temps: { flowrate: number } }
    right: { pump: { rpm: number }, temps: { flowrate: number } }
  }): void {
    const now = Date.now()
    if (now - this.lastFlowWrite < 60_000) return

    try {
      biometricsDb
        .insert(flowReadings)
        .values({
          timestamp: new Date(now),
          leftFlowrateCd: Math.round(frzHealth.left.temps.flowrate * 100),
          rightFlowrateCd: Math.round(frzHealth.right.temps.flowrate * 100),
          leftPumpRpm: frzHealth.left.pump.rpm,
          rightPumpRpm: frzHealth.right.pump.rpm,
        })
        .run()
      this.lastFlowWrite = now
    }
    catch (error) {
      console.error('DeviceStateSync: failed to write flow readings:', error instanceof Error ? error.message : error)
    }
  }
}
