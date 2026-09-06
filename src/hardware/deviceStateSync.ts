import { eq } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { waterLevelReadings, flowReadings } from '@/src/db/biometrics-schema'
import { onFrame as pumpStallOnFrame } from './pumpStallGuard'
import { DEFAULT_HEATING_DURATION } from './types'
import type { DeviceStatus, Side } from './types'
import { getLastSideMutationAt } from './sideMutations'

export { markSideMutated, _resetMutationStamps } from './sideMutations'

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

function isSideRecentlyMutated(side: Side): boolean {
  return Date.now() - getLastSideMutationAt(side) < MUTATION_FRESHNESS_MS
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
const SESSION_END_RUNNING_RPM_MIN = 1_500 // strong evidence that both pumps were healthy before stopping
const SESSION_END_RUNNING_EVIDENCE_MS = 30_000 // the healthy frame must immediately precede the stop
const SESSION_EXPIRY_TOLERANCE_MS = 2_000 // integer countdown plus status-poll latency

interface ObservedSession {
  deadline: number
  targetLevel: number
  mutationAt: number
  expired: boolean
}

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
  private observedSession: Record<Side, ObservedSession | null> = { left: null, right: null }
  private isPriming = false
  private primeEndedAt = 0
  private stallGuardInFlight: Record<Side, boolean> = { left: false, right: false }
  private stallGuardPending: Record<Side, { rpm: number, duty: number | null, bilateralStopCandidate: boolean, at: number } | null> = { left: null, right: null }
  private lastBothHealthyAt: number | null = null
  private bilateralStopCandidateUntil = 0

  sync = async (status: DeviceStatus): Promise<void> => {
    const now = Date.now()
    if (this.isPriming && !status.isPriming) {
      this.primeEndedAt = now
    }
    this.isPriming = status.isPriming
    this.recordSideStatus('left', status.leftSide, now)
    this.recordSideStatus('right', status.rightSide, now)

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

  private recordSideStatus(side: Side, status: DeviceStatus['leftSide'], now: number): void {
    const previous = this.lastSideStatus[side]
    const session = this.observedSession[side]
    const mutationAt = getLastSideMutationAt(side)
    const pollGap = previous ? now - previous.at : Infinity

    if (status.targetLevel === 0 || isSideRecentlyMutated(side)) {
      // A neutral target ends this history. Polls just after a command can
      // still describe the old session, so do not adopt their countdown.
      this.observedSession[side] = null
    }
    else if (status.heatingDuration > 0) {
      this.observedSession[side] = {
        deadline: now + status.heatingDuration * 1000,
        targetLevel: status.targetLevel,
        mutationAt,
        expired: false,
      }
    }
    else if (session
      && session.mutationAt === mutationAt
      && session.targetLevel === status.targetLevel
      && pollGap >= 0 && pollGap <= SESSION_END_GRACE_S * 1000
      && (session.expired || now >= session.deadline - SESSION_EXPIRY_TOLERANCE_MS)) {
      // A recently observed positive countdown has actually reached zero.
      // Keep the confirmed end through fresh zero polls even if firmware
      // retains its target/current level indefinitely. This must not become
      // another false trip after a fixed grace period runs out.
      session.expired = true
    }
    else {
      // Zero throughout a session, an early zero, a new target/command, or
      // a missing/rolled-back status stream is not proof of expiry.
      this.observedSession[side] = null
    }
    this.lastSideStatus[side] = { targetLevel: status.targetLevel, heatingDuration: status.heatingDuration, at: now }
  }

  private hasConfirmedSessionEnd(side: Side, now: number): boolean {
    const last = this.lastSideStatus[side]
    const session = this.observedSession[side]
    return Boolean(session?.expired && last
      && session.mutationAt === getLastSideMutationAt(side)
      && last.heatingDuration === 0
      && last.targetLevel === session.targetLevel
      && now >= last.at && now - last.at <= SESSION_END_GRACE_S * 1000)
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

    // An observed countdown expiry or an explicit neutral/zero state ends
    // regulation even while firmware retains the target or current level.
    // Keep the DB/UI off while the water equalizes back to ambient.
    const durationExpired = (sideStatus.targetLevel === 0 && sideStatus.heatingDuration === 0)
      || this.hasConfirmedSessionEnd(side, now.getTime())
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
  private projectedRemainingSeconds(side: Side, now: number): number | null {
    const last = this.lastSideStatus[side]
    return last ? last.heatingDuration - (now - last.at) / 1000 : null
  }

  private isExpectedPumpStop(
    side: Side,
    duty: number | null,
    poweredOnAt: Date | null | undefined,
    bilateralStopCandidate: boolean,
    now: number,
  ): boolean {
    const last = this.lastSideStatus[side]

    // The firmware's neutral target is the authoritative session-end signal.
    // Field data shows pump duty can remain non-zero briefly after this
    // transition, so consulting duty first misclassified normal spin-down as
    // a fresh stall and created acknowledge/restore loops. Bound the snapshot
    // age so a stopped status stream cannot mask a later session indefinitely.
    const snapshotAgeSeconds = last ? (now - last.at) / 1000 : null
    if (last?.targetLevel === 0
      && snapshotAgeSeconds != null
      && snapshotAgeSeconds >= 0
      && snapshotAgeSeconds <= SESSION_END_GRACE_S) return true

    // Some firmware retains the old non-neutral target after heatTime has
    // counted down to zero. That confirmed expiry also outranks stale duty.
    if (this.hasConfirmedSessionEnd(side, now)) return true

    // Duty is authoritative when the frame carries it: 0 means the firmware
    // isn't driving the pump (commanded stop), while a driven pump (duty > 0)
    // reading 0 RPM is exactly the stall signature — never suppress it, even
    // inside a prime or session-end window.
    if (duty !== null) return duty === 0

    // Priming spins both pumps regardless of side power; the spin-down at
    // the end of the cycle reads as RPM 0 for a few frames.
    if (this.isPriming || (this.primeEndedAt > 0 && now - this.primeEndedAt < PRIME_GRACE_MS)) return true

    if (!last) return false

    // Session countdown at or past its natural end. heatingDuration is the
    // remaining seconds at poll time; project it forward so a stalled status
    // stream can't hold suppression off after the session should have ended,
    // but only within a bounded window — a snapshot that is long past its
    // projected end must not suppress a later session's genuine stall.
    // The > 0 gate keeps firmware variants that report 0 during an active
    // session (no countdown) on the plain device_state path.
    const remaining = this.projectedRemainingSeconds(side, now)
    if (last.heatingDuration > 0
      && remaining != null
      && remaining <= SESSION_END_GRACE_S
      && remaining >= -SESSION_END_STALE_S) return true

    // Some firmware reports heatTime=0 for the entire active session and can
    // leave a non-neutral target in the final status snapshot. In that shape,
    // neither the countdown nor target can identify the normal eight-hour
    // firmware stop. Fall back only when both pumps stop together near the
    // persisted OFF->ON timestamp plus the default duration. Keep this fallback
    // to a narrow +/-90s window because poweredOnAt does not move when a later
    // temperature write resets the firmware timer. This is suppression evidence
    // only: no restore duration is synthesized from poweredOnAt.
    if (last.heatingDuration !== 0 || !bilateralStopCandidate || !poweredOnAt) return false
    const defaultRemaining = DEFAULT_HEATING_DURATION - (now - poweredOnAt.getTime()) / 1000
    return defaultRemaining <= SESSION_END_GRACE_S
      && defaultRemaining >= -SESSION_END_GRACE_S
  }

  /**
   * Feed the stall guard, coalesced to one in-flight call per side. A guard
   * pass can hold the side lock for a full DAC timeout (cutoff / retry /
   * recovery); frames keep arriving during that window, and running them
   * concurrently would stack duplicate transitions on the sequential
   * transport. Only the newest frame received while busy is kept.
   */
  private queueStallGuard(side: Side, rpm: number, duty: number | null, bilateralStopCandidate: boolean, at: number): void {
    if (this.stallGuardInFlight[side]) {
      this.stallGuardPending[side] = { rpm, duty, bilateralStopCandidate, at }
      return
    }
    this.stallGuardInFlight[side] = true
    void (async () => {
      // runStallGuard catches internally today; finally guarantees the
      // in-flight flag is released even if that ever changes — a leaked
      // flag would silently stop feeding the guard for this side.
      try {
        await this.runStallGuard(side, rpm, duty, bilateralStopCandidate, at)
        let next = this.stallGuardPending[side]
        while (next) {
          this.stallGuardPending[side] = null
          await this.runStallGuard(side, next.rpm, next.duty, next.bilateralStopCandidate, next.at)
          next = this.stallGuardPending[side]
        }
      }
      finally {
        this.stallGuardInFlight[side] = false
      }
    })()
  }

  /** Look up the side's commanded state and feed the pump stall guard.
   *  `at` is the frame's arrival stamp — the guard's dwell clock runs on
   *  frame arrival, not processing time, so a queued frame that waited out a
   *  lock hold can't inflate the low-run span it evidences. */
  private async runStallGuard(side: Side, rpm: number, duty: number | null, bilateralStopCandidate: boolean, at: number): Promise<void> {
    try {
      const [row] = db
        .select({
          isPowered: deviceState.isPowered,
          targetTemperature: deviceState.targetTemperature,
          poweredOnAt: deviceState.poweredOnAt,
        })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()
      // Dwell and session-projection clocks run on the frame's arrival stamp,
      // not drain time — see the doc above.
      const now = at
      const expectedActive = !this.isExpectedPumpStop(side, duty, row?.poweredOnAt, bilateralStopCandidate, now)
        && Boolean(row?.isPowered && row.targetTemperature != null)
      // Real remaining session seconds, projected from the last firmware
      // poll like isExpectedPumpStop. The guard restores this snapshot on
      // auto-recovery, and feeding it the literal 8h default re-armed
      // sessions that ended at arbitrary times (the daily false-trip loop).
      // Firmware variants with no countdown (heatingDuration 0) project to
      // <= 0 and fall to the null arm below — auto-recovery then clears the
      // guard without re-energizing.
      const projectedRemainingSeconds = this.projectedRemainingSeconds(side, now)
      const remainingSessionSeconds = projectedRemainingSeconds == null
        ? null
        : Math.round(projectedRemainingSeconds)
      await pumpStallOnFrame({
        side,
        rpm,
        expectedActive,
        preStallTarget: row?.targetTemperature ?? null,
        preStallDurationSeconds:
          expectedActive && remainingSessionSeconds != null && remainingSessionSeconds > 0
            ? remainingSessionSeconds
            : null,
        now,
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
    // A one-frame bilateral 0-RPM drop immediately after both pumps were
    // clearly running is the field-observed telemetry-glitch signature. Drop
    // just that frame; sustained bilateral zero reaches the guard next frame.
    const bothZero = leftRpm === 0 && rightRpm === 0
    const bothHealthy = leftRpm >= SESSION_END_RUNNING_RPM_MIN
      && rightRpm >= SESSION_END_RUNNING_RPM_MIN
    const healthyEvidenceAge = this.lastBothHealthyAt == null
      ? null
      : now - this.lastBothHealthyAt
    const suppressGlitch = bothZero
      && healthyEvidenceAge != null
      && healthyEvidenceAge >= 0
      && healthyEvidenceAge <= SESSION_END_RUNNING_EVIDENCE_MS
    if (suppressGlitch) {
      this.bilateralStopCandidateUntil = now + SESSION_END_GRACE_S * 1000
    }
    else if (!bothZero) {
      this.bilateralStopCandidateUntil = 0
    }
    const bilateralStopCandidate = bothZero
      && this.bilateralStopCandidateUntil > 0
      && now <= this.bilateralStopCandidateUntil
    this.lastBothHealthyAt = bothHealthy ? now : null
    if (!suppressGlitch) {
      this.queueStallGuard('left', leftRpm, leftPump.duty, bilateralStopCandidate, now)
      this.queueStallGuard('right', rightRpm, rightPump.duty, bilateralStopCandidate, now)
    }

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
