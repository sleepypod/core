import { eq } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { waterLevelReadings, flowReadings } from '@/src/db/biometrics-schema'
import type { DeviceStatus, Side } from './types'

/**
 * Consumes status:updated events and writes current device state to the DB.
 * Tracks power transitions (OFF→ON stamps poweredOnAt, ON→OFF clears it).
 *
 * Sleep records are handled exclusively by the sleep-detector module, which
 * uses capacitance sensor data for accurate presence detection rather than
 * power-cycle heuristics.
 */

// ── Mutation freshness ────────────────────────────────────────────────────
// Manual mutations (setPower, setTemperature, setAlarm, scheduler power_off,
// autoOffWatcher) write powered-state to device_state synchronously. The
// firmware then needs ~1–3s to reflect the command in its status report,
// during which a poll can carry stale data (e.g. setPower(true) writes
// is_powered=1 but the next 1s-poll still reports targetLevel=0/
// heatingDuration=0/currentLevel=0 — durationExpired is true → isNowPowered
// is false → the fresh write gets clobbered). Mutations stamp this map so
// upsertSide can skip the powered-state portion of the write inside the
// freshness window. Observation fields (current temperature, water level)
// still update normally.
const MUTATION_FRESHNESS_MS = 5_000
const recentMutations: Record<Side, number> = { left: 0, right: 0 }

/** Mark a side as just-mutated; suppresses powered-state overwrite from
 *  the next firmware poll(s) within the freshness window. */
export function markSideMutated(side: Side): void {
  recentMutations[side] = Date.now()
}

function isSideRecentlyMutated(side: Side): boolean {
  return Date.now() - recentMutations[side] < MUTATION_FRESHNESS_MS
}

/** @internal — for tests only */
export function _resetMutationStamps(): void {
  recentMutations.left = 0
  recentMutations.right = 0
}
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

// ── Flow anomaly detection thresholds ──
const PUMP_FAILURE_RPM_MIN = 50 // pump "running" but below this = suspicious
const FLOWRATE_NEAR_ZERO_CD = 5 // centidegrees — effectively zero flow
const FLOWRATE_SUDDEN_CHANGE_CD = 500 // centidegrees — large delta between consecutive reads
const ASYMMETRY_THRESHOLD_CD = 300 // centidegrees — left/right divergence threshold
const ANOMALY_LOG_COOLDOWN_MS = 300_000 // 5 min between repeated warnings per type

export class DeviceStateSync {
  private lastWaterLevelWrite = 0
  private lastFlowWrite = 0
  private lastAnomalyLog: Record<string, number> = {}
  private prevFlowLeft: number | null = null
  private prevFlowRight: number | null = null

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

    // Stale display fix: if firmware reports targetLevel=0 AND heatingDuration=0,
    // the pod has returned to neutral after its duration expired. Force isPowered
    // to false regardless of currentLevel (which may still be non-zero while the
    // water temperature equalizes back to ambient).
    const durationExpired = sideStatus.targetLevel === 0 && sideStatus.heatingDuration === 0
    const isNowPowered = durationExpired ? false : sideStatus.currentLevel !== 0

    const skipPoweredFields = isSideRecentlyMutated(side)

    db.transaction((tx) => {
      const [prev] = tx
        .select({
          isPowered: deviceState.isPowered,
          poweredOnAt: deviceState.poweredOnAt,
          targetTemperature: deviceState.targetTemperature,
        })
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

      // When duration has expired, clear the target temperature so the UI
      // doesn't show a stale "warming to X°F" when the pod is actually neutral.
      const targetTemp = durationExpired ? null : sideStatus.targetTemperature

      // If a mutation just landed, the firmware status is likely stale —
      // preserve the mutation's powered-state fields and only refresh
      // observation fields (currentTemperature, waterLevel).
      const writeIsPowered = skipPoweredFields ? wasPowered : isNowPowered
      const writePoweredOnAt = skipPoweredFields ? prev?.poweredOnAt ?? null : poweredOnAt
      const writeTargetTemp = skipPoweredFields ? prev?.targetTemperature ?? null : targetTemp

      tx
        .insert(deviceState)
        .values({
          side,
          currentTemperature: sideStatus.currentTemperature,
          targetTemperature: writeTargetTemp,
          isPowered: writeIsPowered,
          waterLevel: status.waterLevel,
          poweredOnAt: writePoweredOnAt,
          lastUpdated: now,
        })
        .onConflictDoUpdate({
          target: deviceState.side,
          set: {
            currentTemperature: sideStatus.currentTemperature,
            targetTemperature: writeTargetTemp,
            isPowered: writeIsPowered,
            waterLevel: status.waterLevel,
            poweredOnAt: writePoweredOnAt,
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
  recordFlowData(frame: Record<string, unknown>): void {
    // Guard: only process frzHealth frames (could be piezo, capSense, bedTemp, etc.)
    const left = frame.left
    const right = frame.right
    if (
      !left || typeof left !== 'object' || !('pump' in left) || !('temps' in left)
      || !right || typeof right !== 'object' || !('pump' in right) || !('temps' in right)
    ) return

    const frzHealth = frame as {
      left: { pump: { rpm: number }, temps: { flowrate?: number } }
      right: { pump: { rpm: number }, temps: { flowrate?: number } }
    }

    const now = Date.now()

    // Run anomaly checks on every frame (not rate-limited)
    this.checkFlowAnomalies(frzHealth, now)

    if (now - this.lastFlowWrite < 60_000) return

    try {
      biometricsDb
        .insert(flowReadings)
        .values({
          timestamp: new Date(now),
          leftFlowrateCd: frzHealth.left.temps?.flowrate != null ? Math.round(frzHealth.left.temps.flowrate * 100) : null,
          rightFlowrateCd: frzHealth.right.temps?.flowrate != null ? Math.round(frzHealth.right.temps.flowrate * 100) : null,
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

  /** Log an anomaly warning, rate-limited per anomaly type. */
  private logAnomaly(type: string, message: string, now: number): void {
    const lastLog = this.lastAnomalyLog[type] ?? 0
    if (now - lastLog < ANOMALY_LOG_COOLDOWN_MS) return
    console.warn(`[FlowAnomaly] ${type}: ${message}`)
    this.lastAnomalyLog[type] = now
  }

  /** Check for flow/pump anomalies on each frzHealth frame. */
  private checkFlowAnomalies(frzHealth: {
    left: { pump: { rpm: number }, temps: { flowrate?: number } }
    right: { pump: { rpm: number }, temps: { flowrate?: number } }
  }, now: number): void {
    const leftRpm = frzHealth.left.pump.rpm
    const rightRpm = frzHealth.right.pump.rpm
    const leftFlowCd = frzHealth.left.temps?.flowrate != null ? Math.round(frzHealth.left.temps.flowrate * 100) : NaN
    const rightFlowCd = frzHealth.right.temps?.flowrate != null ? Math.round(frzHealth.right.temps.flowrate * 100) : NaN

    // Pump running but flowrate missing — possible sensor fault
    if (leftRpm >= PUMP_FAILURE_RPM_MIN && Number.isNaN(leftFlowCd)) {
      this.logAnomaly('left_flowrate_missing',
        `Left pump running at ${leftRpm} RPM but flowrate unavailable`, now)
    }
    if (rightRpm >= PUMP_FAILURE_RPM_MIN && Number.isNaN(rightFlowCd)) {
      this.logAnomaly('right_flowrate_missing',
        `Right pump running at ${rightRpm} RPM but flowrate unavailable`, now)
    }

    // Pump running but no flow — possible pump failure or blockage
    if (leftRpm >= PUMP_FAILURE_RPM_MIN && !Number.isNaN(leftFlowCd) && Math.abs(leftFlowCd) < FLOWRATE_NEAR_ZERO_CD) {
      this.logAnomaly('left_pump_no_flow',
        `Left pump running at ${leftRpm} RPM but flowrate near zero (${leftFlowCd} cd)`, now)
    }
    if (rightRpm >= PUMP_FAILURE_RPM_MIN && !Number.isNaN(rightFlowCd) && Math.abs(rightFlowCd) < FLOWRATE_NEAR_ZERO_CD) {
      this.logAnomaly('right_pump_no_flow',
        `Right pump running at ${rightRpm} RPM but flowrate near zero (${rightFlowCd} cd)`, now)
    }

    // Asymmetric flowrate — possible partial blockage
    if (Math.abs(leftFlowCd - rightFlowCd) > ASYMMETRY_THRESHOLD_CD
      && Math.abs(leftFlowCd) > FLOWRATE_NEAR_ZERO_CD
      && Math.abs(rightFlowCd) > FLOWRATE_NEAR_ZERO_CD) {
      this.logAnomaly('flow_asymmetry',
        `Left/right flowrate diverged: ${leftFlowCd} vs ${rightFlowCd} cd`, now)
    }

    // Sudden large flowrate change — possible leak or sensor fault
    if (this.prevFlowLeft !== null) {
      const deltaLeft = Math.abs(leftFlowCd - this.prevFlowLeft)
      if (deltaLeft > FLOWRATE_SUDDEN_CHANGE_CD) {
        this.logAnomaly('left_flow_spike',
          `Left flowrate sudden change: ${this.prevFlowLeft} -> ${leftFlowCd} cd (delta ${deltaLeft})`, now)
      }
    }
    if (this.prevFlowRight !== null) {
      const deltaRight = Math.abs(rightFlowCd - this.prevFlowRight)
      if (deltaRight > FLOWRATE_SUDDEN_CHANGE_CD) {
        this.logAnomaly('right_flow_spike',
          `Right flowrate sudden change: ${this.prevFlowRight} -> ${rightFlowCd} cd (delta ${deltaRight})`, now)
      }
    }

    this.prevFlowLeft = Number.isFinite(leftFlowCd) ? leftFlowCd : this.prevFlowLeft
    this.prevFlowRight = Number.isFinite(rightFlowCd) ? rightFlowCd : this.prevFlowRight
  }
}
