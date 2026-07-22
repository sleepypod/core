import { eq } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { waterLevelReadings, flowReadings } from '@/src/db/biometrics-schema'
import { onFrame as pumpStallOnFrame } from './pumpStallGuard'
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

/**
 * Extract a well-formed pump object from a frzHealth side. Returns the pump
 * only when `side.pump.rpm` is a finite number — otherwise frzHealth-shaped
 * frames with a null/garbled pump would crash the downstream insert.
 * `duty` (commanded PWM drive) is optional on the wire; null when absent
 * or malformed.
 */
function pumpOf(side: unknown): { rpm: number, duty: number | null } | null {
  if (!side || typeof side !== 'object') return null
  const pump = (side as { pump?: unknown }).pump
  if (!pump || typeof pump !== 'object') return null
  const rpm = (pump as { rpm?: unknown }).rpm
  if (typeof rpm !== 'number' || !Number.isFinite(rpm)) return null
  const duty = (pump as { duty?: unknown }).duty
  return { rpm, duty: typeof duty === 'number' && Number.isFinite(duty) ? duty : null }
}

// ── Flow anomaly detection thresholds ──
const PUMP_FAILURE_RPM_MIN = 50 // pump "running" but below this = suspicious
const FLOWRATE_NEAR_ZERO_CD = 5 // centidegrees — effectively zero flow
const FLOWRATE_SUDDEN_CHANGE_CD = 500 // centidegrees — large delta between consecutive reads
const ASYMMETRY_THRESHOLD_CD = 300 // centidegrees — left/right divergence threshold
const ANOMALY_LOG_COOLDOWN_MS = 300_000 // 5 min between repeated warnings per type

// ── Expected-pump-stop suppression (stall guard false-trip fix) ──
const PRIME_GRACE_MS = 120_000 // pumps spin down at prime end; RPM 0 is expected
const SESSION_END_GRACE_S = 90 // remaining session seconds within which a stop is natural
const SESSION_END_STALE_S = 600 // stop trusting the projected countdown this long past its end

export class DeviceStateSync {
  private lastWaterLevelWrite = 0
  private lastFlowWrite = 0
  private lastAnomalyLog: Record<string, number> = {}
  private prevFlowLeft: number | null = null
  private prevFlowRight: number | null = null
  // Latest firmware-reported side state, kept off the DB mirror: device_state
  // can report a side powered for minutes after the firmware ends a session
  // (currentLevel stays non-zero while the water equalizes), which is exactly
  // the lag that false-tripped the stall guard on every session end.
  private lastSideStatus: Record<Side, { targetLevel: number, heatingDuration: number, at: number } | null> = { left: null, right: null }
  private isPriming = false
  private primeEndedAt = 0
  private stallGuardInFlight: Record<Side, boolean> = { left: false, right: false }
  private stallGuardPending: Record<Side, { rpm: number, duty: number | null } | null> = { left: null, right: null }

  sync = async (status: DeviceStatus): Promise<void> => {
    const now = Date.now()
    if (this.isPriming && !status.isPriming) {
      this.primeEndedAt = now
    }
    this.isPriming = status.isPriming
    this.lastSideStatus.left = { targetLevel: status.leftSide.targetLevel, heatingDuration: status.leftSide.heatingDuration, at: now }
    this.lastSideStatus.right = { targetLevel: status.rightSide.targetLevel, heatingDuration: status.rightSide.heatingDuration, at: now }

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
    // `temps` is optional per WireFrzHealth — many pods emit frzHealth without it,
    // so gate on a well-formed `pump` only and treat flowrate as missing when absent.
    const leftPump = pumpOf(frame.left)
    const rightPump = pumpOf(frame.right)
    if (!leftPump || !rightPump) return

    const frzHealth = frame as {
      left: { pump: { rpm: number }, temps?: { flowrate?: number } }
      right: { pump: { rpm: number }, temps?: { flowrate?: number } }
    }

    const now = Date.now()

    // Run anomaly checks on every frame (not rate-limited)
    this.checkFlowAnomalies(frzHealth, leftPump, rightPump, now)

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

  /**
   * True when a zero-RPM frame is explainable by a firmware-commanded pump
   * stop rather than a mechanical stall. Every signal here is firmware-side
   * and lag-free — unlike device_state, which mirrors the firmware through
   * the durationExpired heuristic and stays "powered" for minutes after a
   * session ends on the firmware side.
   */
  private isExpectedPumpStop(side: Side, duty: number | null, now: number): boolean {
    // Duty is authoritative when the frame carries it: 0 means the firmware
    // isn't driving the pump (commanded stop), while a driven pump (duty > 0)
    // reading 0 RPM is exactly the stall signature — never suppress it, even
    // inside a prime or session-end window.
    if (duty !== null) return duty === 0

    // Priming spins both pumps regardless of side power; the spin-down at
    // the end of the cycle reads as RPM 0 for a few frames.
    if (this.isPriming || (this.primeEndedAt > 0 && now - this.primeEndedAt < PRIME_GRACE_MS)) return true

    const last = this.lastSideStatus[side]
    if (!last) return false

    // Firmware target is neutral — the pump is expected to stop even while
    // device_state still mirrors the old session.
    if (last.targetLevel === 0) return true

    // Session countdown at or past its natural end. heatingDuration is the
    // remaining seconds at poll time; project it forward so a stalled status
    // stream can't hold suppression off after the session should have ended,
    // but only within a bounded window — a snapshot that is long past its
    // projected end must not suppress a later session's genuine stall.
    // The > 0 gate keeps firmware variants that report 0 during an active
    // session (no countdown) on the plain device_state path.
    const remaining = last.heatingDuration - (now - last.at) / 1000
    return last.heatingDuration > 0
      && remaining <= SESSION_END_GRACE_S
      && remaining >= -SESSION_END_STALE_S
  }

  /**
   * Feed the stall guard, coalesced to one in-flight call per side. A guard
   * pass can hold the side lock for a full DAC timeout (cutoff / retry /
   * recovery); frames keep arriving during that window, and running them
   * concurrently would stack duplicate transitions on the sequential
   * transport. Only the newest frame received while busy is kept.
   */
  private queueStallGuard(side: Side, rpm: number, duty: number | null): void {
    if (this.stallGuardInFlight[side]) {
      this.stallGuardPending[side] = { rpm, duty }
      return
    }
    this.stallGuardInFlight[side] = true
    void (async () => {
      // runStallGuard catches internally today; finally guarantees the
      // in-flight flag is released even if that ever changes — a leaked
      // flag would silently stop feeding the guard for this side.
      try {
        await this.runStallGuard(side, rpm, duty)
        let next = this.stallGuardPending[side]
        while (next) {
          this.stallGuardPending[side] = null
          await this.runStallGuard(side, next.rpm, next.duty)
          next = this.stallGuardPending[side]
        }
      }
      finally {
        this.stallGuardInFlight[side] = false
      }
    })()
  }

  /** Look up the side's commanded state and feed the pump stall guard. */
  private async runStallGuard(side: Side, rpm: number, duty: number | null): Promise<void> {
    try {
      const [row] = db
        .select({
          isPowered: deviceState.isPowered,
          targetTemperature: deviceState.targetTemperature,
        })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()
      const expectedActive = !this.isExpectedPumpStop(side, duty, Date.now())
        && Boolean(row?.isPowered && row.targetTemperature != null)
      await pumpStallOnFrame({
        side,
        rpm,
        expectedActive,
        preStallTarget: row?.targetTemperature ?? null,
        preStallDurationSeconds: expectedActive ? 28800 : null,
      })
    }
    catch (err) {
      console.warn('[deviceStateSync] pump stall guard call failed:', err instanceof Error ? err.message : err)
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
    left: { pump: { rpm: number }, temps?: { flowrate?: number } }
    right: { pump: { rpm: number }, temps?: { flowrate?: number } }
  }, leftPump: { rpm: number, duty: number | null }, rightPump: { rpm: number, duty: number | null }, now: number): void {
    const leftRpm = leftPump.rpm
    const rightRpm = rightPump.rpm
    const leftFlowCd = frzHealth.left.temps?.flowrate != null ? Math.round(frzHealth.left.temps.flowrate * 100) : NaN
    const rightFlowCd = frzHealth.right.temps?.flowrate != null ? Math.round(frzHealth.right.temps.flowrate * 100) : NaN

    // Feed the per-side stall guard. Reads current device_state to derive
    // expectedActive — a side that's commanded off should not trip on
    // RPM = 0 since that is the correct value.
    this.queueStallGuard('left', leftRpm, leftPump.duty)
    this.queueStallGuard('right', rightRpm, rightPump.duty)

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
