/**
 * Pump stall safety guard — per-side state machine that converts pump-RPM
 * frames into trip / recover decisions.
 *
 * See ADR 0022 for the design rationale. The short version:
 *   - When the pump RPM stays below the trip threshold for dwellSamples
 *     consecutive frames on a side commanded active, the side is powered
 *     off and a `pump_alerts` row is written.
 *   - Subsequent setTemperature / setPower(on) / keepalive re-issue calls
 *     consult shouldBlock(side) so no command silently re-engages a side
 *     whose pump is faulted.
 *   - Auto-recovery is opt-in: only when enabled, and only after
 *     recoverySamples consecutive frames at or above recoveryRpm.
 *
 * State lives on globalThis for the same Turbopack-chunking reason as
 * primeNotification.ts — onFrame fires from the DAC monitor runtime, while
 * shouldBlock is read from API route handlers.
 */

import { and, desc, eq, isNull, lt, lte } from 'drizzle-orm'
import { biometricsDb, db } from '@/src/db'
import { pumpAlerts } from '@/src/db/biometrics-schema'
import { deviceSettings, deviceState } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/sharedClient'
import { clearPumpStallNotice, setPumpStallNotice } from './pumpStallNotification'
import { remainingPumpStallRestore } from './pumpStallRestore'
import type { PumpStallRestore } from './pumpStallRestore'
import { withSideLock } from './sideLock'
import { getLastSideMutationAt } from './sideMutations'
import type { Side } from './types'

interface GuardState {
  consecutiveLowFrames: number
  consecutiveHealthyFrames: number
  blocked: boolean
  trippedAt: number | null
  /** id of the pump_alerts row written at trip — used by auto-recover to
   *  update `action` on the same row. */
  activeAlertId: number | null
  preStall: PumpStallRestore | null
  /** true when the trip-time hardware power-off never went out — retried
   *  on every subsequent frame until it succeeds. */
  cutoffPending: boolean
  /** Epoch ms of the first frame in the current sub-threshold run. */
  lowSince: number | null
  /** frame-arrival ms of the last frame observed for this side — a gap
   *  beyond FRAME_GAP_RESET_MS invalidates any accumulated low run. */
  lastFrameAt: number | null
  /** lowSince of the run whose bilateral hold was already logged — compared
   *  by value so a fresh run logs again without extra reset plumbing. */
  bilateralHoldLoggedFor: number | null
  /** Number of active auto-recovery probes started since this trip. */
  recoveryAttempts: number
  /** Epoch ms when the current recovery probe energized the side. */
  probeStartedAt: number | null
  /** Epoch ms when the previous recovery probe ended. */
  lastProbeEndedAt: number | null
  /** A user resolution owns this state while its hardware write is in flight. */
  resolutionPending: boolean
  /** true when this block was restored from a persisted row at startup
   *  rather than tripped in this boot. A rehydrated block self-releases on
   *  live healthy-RPM evidence; a fresh trip requires explicit
   *  acknowledgement (or opt-in auto-recovery). */
  rehydrated: boolean
}

interface GuardSettings {
  enabled: boolean
  threshold: number
  dwellSamples: number
  autoRecoveryEnabled: boolean
  recoveryRpm: number
  recoverySamples: number
}

interface SettingsCacheState {
  cached: { value: GuardSettings, at: number, available: boolean } | null
  lastReadAvailable: boolean
}

const G = globalThis as Record<string, unknown>
const STATE_KEY = '__sp_pump_stall_guard_state__'
const SETTINGS_STATE_KEY = '__sp_pump_stall_guard_settings_state__'

function getState(): Record<Side, GuardState> {
  let s = G[STATE_KEY] as Record<Side, GuardState> | undefined
  if (!s) {
    s = {
      left: emptyState(),
      right: emptyState(),
    }
    G[STATE_KEY] = s
  }
  return s
}

function emptyState(): GuardState {
  return {
    consecutiveLowFrames: 0,
    consecutiveHealthyFrames: 0,
    blocked: false,
    trippedAt: null,
    activeAlertId: null,
    preStall: null,
    cutoffPending: false,
    lowSince: null,
    lastFrameAt: null,
    bilateralHoldLoggedFor: null,
    recoveryAttempts: 0,
    probeStartedAt: null,
    lastProbeEndedAt: null,
    resolutionPending: false,
    rehydrated: false,
  }
}

// A trip must satisfy both the configurable frame count and this wall-clock
// floor. Field frames arrive much faster than the original design assumed, so
// dwellSamples=2 alone allowed ~2-second telemetry glitches to cut power.
// Both requirements are measured on the frame-arrival clock (not processing
// time), and an inter-frame gap beyond FRAME_GAP_RESET_MS invalidates the run
// so a burst of queued frames (stream reconnect replay) or two sparse zeros
// straddling an outage cannot satisfy the dwell.
const DWELL_MIN_MS = 10_000
const FRAME_GAP_RESET_MS = 30_000

// Both sides read the same frzHealth frame, so a shared telemetry/firmware
// glitch reports zero on both sides at once — the 2026-08 field trips were
// exactly this (journal showed both pumps commanded ~1950 rpm while frames
// read 0/0). Real mechanical stalls are overwhelmingly single-sided: a low
// run whose onset lands within BILATERAL_ONSET_WINDOW_MS of the other side's
// (~1.5 nominal frame intervals, tolerating coalescing skew) must sustain
// BILATERAL_DWELL_MIN_MS before tripping. A genuine shared failure (common
// supply fault) still fails safe after the extended dwell.
const BILATERAL_ONSET_WINDOW_MS = 15_000
const BILATERAL_DWELL_MIN_MS = 120_000

// A cutoff leaves RPM at zero, so passive recovery can never prove that the
// pump is healthy. Opt-in recovery briefly energizes the side after these
// backoffs, then requires the configured healthy-RPM evidence during a bounded
// probe window.
const PROBE_BACKOFFS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000]
const PROBE_WINDOW_MS = 60_000

// ── Settings cache ─────────────────────────────────────────────────────────
// `recordFlowData` fires every frame; reading device_settings on each call
// would do extra SQL per second. Cache for a few seconds — settings
// mutations are rare and a short staleness window is fine for safety dwell.
const SETTINGS_TTL_MS = 5_000

function getSettingsState(): SettingsCacheState {
  let state = G[SETTINGS_STATE_KEY] as SettingsCacheState | undefined
  if (!state) {
    state = { cached: null, lastReadAvailable: true }
    G[SETTINGS_STATE_KEY] = state
  }
  return state
}

function readSettings(): GuardSettings {
  const now = Date.now()
  const state = getSettingsState()
  if (state.cached && now - state.cached.at < SETTINGS_TTL_MS) {
    state.lastReadAvailable = state.cached.available
    return state.cached.value
  }

  let row: typeof deviceSettings.$inferSelect | undefined
  let available = false
  try {
    [row] = db.select().from(deviceSettings).limit(1).all()
    available = row != null
    if (!available) {
      console.warn('[pumpStallGuard] device settings row is missing — preserving any armed guard')
    }
  }
  catch (err) {
    console.warn('[pumpStallGuard] failed to read settings — preserving any armed guard:', err instanceof Error ? err.message : err)
  }

  const value: GuardSettings = {
    // Fail-safe-off: an opt-in power-cutting feature must never arm on missing
    // data. Matches the schema/seed/router default and the 0012 backfill. The
    // availability flag separately prevents this fallback from dismantling an
    // already-armed transition after a read error.
    enabled: row?.pumpStallProtectionEnabled ?? false,
    threshold: row?.pumpStallRpmThreshold ?? 500,
    dwellSamples: row?.pumpStallDwellSamples ?? 2,
    autoRecoveryEnabled: row?.pumpStallAutoRecoveryEnabled ?? false,
    recoveryRpm: row?.pumpStallRecoveryRpm ?? 1500,
    recoverySamples: row?.pumpStallRecoverySamples ?? 3,
  }
  state.cached = { value, at: now, available }
  state.lastReadAvailable = available
  return value
}

/** Invalidate the settings cache; call after a device_settings mutation. */
export function invalidateGuardSettingsCache(): void {
  getSettingsState().cached = null
}

// ── Per-frame entry point ──────────────────────────────────────────────────

export interface OnFrameInput {
  side: Side
  rpm: number
  expectedActive: boolean
  preStallTarget: number | null
  preStallDurationSeconds: number | null
  /** Receipt time of this telemetry frame. Defaults to the local clock. */
  now?: number
}

export async function onFrame(input: OnFrameInput): Promise<void> {
  const settings = readSettings()
  const state = getState()[input.side]
  const now = input.now ?? Date.now()

  if (!getSettingsState().lastReadAvailable) {
    // An unavailable settings row is not evidence that the user disabled
    // protection. Do not arm a new incident from unknown configuration, but
    // never abandon hardware-off work that was already armed. An active probe
    // is conservatively parked; a failed park leaves cutoffPending asserted so
    // the next settings retry can continue the cutoff.
    state.consecutiveLowFrames = 0
    state.consecutiveHealthyFrames = 0
    state.lowSince = null
    if (state.blocked && state.probeStartedAt != null) {
      state.cutoffPending = true
      state.probeStartedAt = null
      state.lastProbeEndedAt = now
    }
    if (state.blocked && state.cutoffPending) {
      await parkRecoveryProbe(input.side, state, 'settings-unavailable recovery')
    }
    return
  }

  if (!settings.enabled) {
    state.consecutiveLowFrames = 0
    state.consecutiveHealthyFrames = 0
    state.blocked = false
    state.lowSince = null
    state.recoveryAttempts = 0
    state.probeStartedAt = null
    state.lastProbeEndedAt = null
    state.preStall = null
    state.resolutionPending = false
    // The flag must fall with the block: a leaked flag would let a later fresh
    // trip inherit the rehydrated self-release.
    state.rehydrated = false
    return
  }

  // A manual resolution owns the side until its one duration-bearing write
  // succeeds or its failure path re-arms and parks. Keep telemetry from
  // starting a competing recovery transition in that interval.
  if (state.resolutionPending) return

  if (!input.expectedActive && !state.blocked) {
    // Side commanded off — RPM of zero is the correct state, don't penalize.
    // A blocked side falls through: trip() mirrors isPowered=false, so
    // expectedActive is false for every post-trip frame and returning here
    // would make the cutoff retry and recovery tracking below unreachable.
    state.consecutiveLowFrames = 0
    state.lowSince = null
    state.lastFrameAt = now
    // A confirmed stop is a session boundary. Retaining the previous
    // session's countdown here could make a later no-countdown session
    // restore stale time after a trip.
    state.preStall = null
    return
  }

  // A gap in the frame stream breaks run continuity — whatever accumulated
  // before the gap is stale evidence, so the run restarts from this frame.
  if (state.lastFrameAt != null && now - state.lastFrameAt > FRAME_GAP_RESET_MS) {
    state.consecutiveLowFrames = 0
    state.lowSince = null
  }
  state.lastFrameAt = now

  // Remember the most recent healthy operating point so a trip can capture
  // a useful snapshot even if firmware briefly under-reports between
  // setpoint and stall.
  if (input.preStallTarget != null && input.preStallDurationSeconds != null && !state.blocked) {
    state.preStall = {
      targetTemperature: input.preStallTarget,
      durationSeconds: input.preStallDurationSeconds,
    }
  }

  if (!state.blocked) {
    if (input.rpm < settings.threshold) {
      const other = getState()[input.side === 'left' ? 'right' : 'left']
      state.consecutiveLowFrames += 1
      if (state.lowSince == null) state.lowSince = now

      // A shared telemetry glitch zeros both sides at once; hold such a run to
      // the longer bilateral dwell before tripping (see the constants above).
      const bilateralOnset = other.lowSince != null
        && Math.abs(state.lowSince - other.lowSince) <= BILATERAL_ONSET_WINDOW_MS
      const dwellFloorMs = bilateralOnset ? BILATERAL_DWELL_MIN_MS : DWELL_MIN_MS

      if (state.consecutiveLowFrames >= settings.dwellSamples
        && now - state.lowSince >= dwellFloorMs) {
        await trip(input.side, input.rpm, now)
      }
      else if (
        bilateralOnset
        && state.consecutiveLowFrames >= settings.dwellSamples
        && now - state.lowSince >= DWELL_MIN_MS
        && state.bilateralHoldLoggedFor !== state.lowSince
      ) {
        state.bilateralHoldLoggedFor = state.lowSince
        console.warn(`[pumpStallGuard] ${input.side}: bilateral zero-RPM onset — holding trip for sustained evidence (${BILATERAL_DWELL_MIN_MS / 1000}s; shared telemetry glitch suspected)`)
      }
    }
    else {
      state.consecutiveLowFrames = 0
      state.lowSince = null
    }
    return
  }

  // A rehydrated block carries no cutoff confirmation from this boot: if
  // the pre-restart cutoff never landed, the side may still be energized
  // against a stalled pump. Watch for that evidence — commanded active with
  // sub-threshold RPM for the dwell window — and arm the retry below.
  // Healthy frames reset the dwell, so a side that is actually running
  // fine is never touched.
  if (state.rehydrated && !state.cutoffPending && input.expectedActive) {
    if (input.rpm < settings.threshold) {
      state.consecutiveLowFrames += 1
      if (state.lowSince == null) state.lowSince = now
      if (state.consecutiveLowFrames >= settings.dwellSamples
        && now - state.lowSince >= DWELL_MIN_MS) {
        state.consecutiveLowFrames = 0
        state.lowSince = null
        state.cutoffPending = true
        // Start recovery backoff from this boot's live confirmation, not the
        // possibly old persisted incident timestamp.
        state.lastProbeEndedAt = now
        // The stall was just re-confirmed on trip()'s own evidence bar —
        // the block is a live incident now, not a stale carry-over, so the
        // rehydrated self-release no longer applies and explicit
        // acknowledgement is required again.
        state.rehydrated = false
        console.warn(`[pumpStallGuard] rehydrated block for ${input.side} sees an energized stalled pump — powering off`)
      }
    }
    else {
      state.consecutiveLowFrames = 0
      state.lowSince = null
    }
  }

  // Already blocked — if the trip-time cutoff never reached the hardware,
  // the side may still be energized against a stalled pump. Retry until
  // the command is confirmed sent; the alert row already says power_off.
  if (state.cutoffPending) {
    try {
      await withSideLock(input.side, async () => {
        const client = getSharedHardwareClient()
        await client.setPower(input.side, false)
      })
      state.cutoffPending = false
    }
    catch (err) {
      console.warn(`[pumpStallGuard] cutoff retry for ${input.side} failed:`, err instanceof Error ? err.message : err)
    }
  }

  // Preserve the existing healthy-RPM proof for already-running hardware,
  // while scheduled probes make recovery reachable after a successful cutoff
  // has left the pump at zero. Auto-recovery remains explicitly opt-in.
  if (input.rpm >= settings.recoveryRpm) state.consecutiveHealthyFrames += 1
  else state.consecutiveHealthyFrames = 0

  if (settings.autoRecoveryEnabled
    && state.consecutiveHealthyFrames >= settings.recoverySamples) {
    await autoRecover(input.side, now)
    return
  }

  if (!settings.autoRecoveryEnabled) {
    // Turning auto-recovery off must stop the work it started before a
    // rehydrated block is allowed to self-release on the probe's healthy RPM.
    if (state.probeStartedAt != null) {
      state.cutoffPending = true
      state.probeStartedAt = null
      state.lastProbeEndedAt = now
      state.consecutiveHealthyFrames = 0
      await parkRecoveryProbe(input.side, state, 'disabled recovery-probe')
      return
    }
    // A rehydrated row has no proof that the old block still describes live
    // hardware. An already-running side can release the stale block without
    // writing hardware when auto-recovery is disabled.
    if (state.rehydrated
      && !state.cutoffPending
      && state.consecutiveHealthyFrames >= settings.recoverySamples) {
      releaseRehydratedBlock(input.side)
    }
    return
  }

  if (state.cutoffPending) return

  if (state.probeStartedAt != null) {
    if (now - state.probeStartedAt >= PROBE_WINDOW_MS) {
      await endFailedProbe(input.side, now)
    }
    return
  }

  if (state.recoveryAttempts >= PROBE_BACKOFFS_MS.length) return

  const backoff = PROBE_BACKOFFS_MS[state.recoveryAttempts]
  const since = state.lastProbeEndedAt ?? state.trippedAt ?? now
  if (now - since >= backoff) {
    await startRecoveryProbe(input.side, now)
  }
}

// ── Block decision used by setTemperature / setPower / keepalive ───────────

export function shouldBlock(side: Side): boolean {
  return getState()[side].blocked
}

// ── Manual acknowledgement (called by tRPC mutation) ───────────────────────

/**
 * Conditionally clear the guard for a side. A supplied alert id must match the
 * live incident, and no acknowledgement can abandon hardware whose cutoff is
 * still unconfirmed. On success, returns the restore snapshot and an opaque
 * token that lets a failed asynchronous restore rearm only this release.
 */
export function acknowledge(side: Side, expectedAlertId?: number): {
  restore: PumpStallRestore | null
  alertId: number | null
  trippedAt: number | null
  conflict: 'alert_mismatch' | 'hardware_pending' | null
  /** Opaque identity of the state released by this acknowledgement. */
  rearmToken: object | null
} {
  const state = getState()[side]
  if (state.resolutionPending) {
    return {
      restore: null,
      alertId: state.activeAlertId,
      trippedAt: state.trippedAt,
      conflict: 'hardware_pending',
      rearmToken: null,
    }
  }
  if (state.blocked && (state.cutoffPending || state.probeStartedAt != null)) {
    return {
      restore: null,
      alertId: state.activeAlertId,
      trippedAt: state.trippedAt,
      conflict: 'hardware_pending',
      rearmToken: null,
    }
  }
  if (expectedAlertId != null
    && state.blocked
    && state.activeAlertId !== expectedAlertId) {
    return {
      restore: null,
      alertId: state.activeAlertId,
      trippedAt: state.trippedAt,
      conflict: 'alert_mismatch',
      rearmToken: null,
    }
  }
  const restore = state.blocked ? state.preStall : null
  const alertId = state.blocked ? state.activeAlertId : null
  const trippedAt = state.blocked ? state.trippedAt : null
  const releasedState = emptyState()
  // Keep the side blocked to every ordinary energizing ingress while the
  // owning route performs its guard-authorized restore write. The persisted
  // incident identity also makes history dismissal conflict until completion.
  releasedState.blocked = true
  releasedState.resolutionPending = true
  releasedState.activeAlertId = alertId ?? expectedAlertId ?? null
  releasedState.trippedAt = trippedAt
  releasedState.preStall = restore
  getState()[side] = releasedState
  return {
    restore,
    alertId,
    trippedAt,
    conflict: null,
    rearmToken: releasedState,
  }
}

/** True while a side may still be energized by a cutoff or recovery probe. */
export function hasUnconfirmedHardware(side: Side): boolean {
  const state = getState()[side]
  return state.resolutionPending
    || (state.blocked && (state.cutoffPending || state.probeStartedAt != null))
}

/**
 * Release the in-memory block when a history-row dismissal names the live
 * incident. Never releases while the trip-time cutoff is unconfirmed — the
 * per-frame retry is the only thing still trying to de-energize the side,
 * and an acknowledge-style reset would abandon it.
 */
export function dismissIfActive(side: Side, alertId: number): boolean {
  const state = getState()[side]
  if (!state.blocked
    || state.activeAlertId !== alertId
    || state.cutoffPending
    || state.probeStartedAt != null
    || state.resolutionPending) return false
  getState()[side] = emptyState()
  clearPumpStallNotice(side)
  return true
}

/**
 * True when this row is the live incident and its hardware cutoff is still
 * unconfirmed. Dismissing such a row would stamp away the only persistent
 * trace of a side possibly energized against a stalled pump — callers
 * should refuse the dismissal outright rather than stamp-then-fail.
 */
export function isCutoffPendingIncident(side: Side, alertId: number): boolean {
  const state = getState()[side]
  return state.blocked
    && state.activeAlertId === alertId
    && hasUnconfirmedHardware(side)
}

// ── Re-arm after a failed acknowledge-and-restore ──────────────────────────

/**
 * Re-block a side whose acknowledgement could not complete. acknowledge()
 * leaves an opaque, guard-owned reservation in place; when the subsequent
 * hardware restore fails, the alert row is still active (nothing was
 * stamped) and the block plus banner must return with it — otherwise the
 * protection is silently lost while the side sits in an unknown power state.
 */
export function rearm(side: Side, params: {
  alertId: number | null
  restore: PumpStallRestore | null
  /** ms epoch of the original trip; defaults to now */
  trippedAt?: number
  rpm?: number
  /** The failed restore may have partially energized hardware. */
  cutoffPending?: boolean
}, expectedState?: object): boolean {
  const state = getState()[side]
  // A restore is debounced and can fail after a newer incident has tripped
  // (or after another user action replaced the released state). Never let
  // that older failure overwrite its successor.
  if (expectedState != null && state !== expectedState) return false
  if (state.blocked && !state.resolutionPending) return false
  state.blocked = true
  state.resolutionPending = false
  state.trippedAt = params.trippedAt ?? Date.now()
  state.activeAlertId = params.alertId
  state.preStall = params.restore
  state.cutoffPending = params.cutoffPending ?? false
  state.consecutiveLowFrames = 0
  state.consecutiveHealthyFrames = 0
  state.lowSince = null
  state.recoveryAttempts = 0
  state.probeStartedAt = null
  state.lastProbeEndedAt = null
  // A failed restore leaves the side in an unknown power state — the
  // re-armed block must require explicit acknowledgement, never the
  // rehydrated self-release.
  state.rehydrated = false
  setPumpStallNotice(side, {
    alertId: params.alertId ?? 0,
    trippedAt: Math.floor(state.trippedAt / 1000),
    rpm: params.rpm ?? 0,
    restore: params.restore,
  })
  return true
}

/** Confirm the compensating power-off for a conditionally re-armed restore. */
export function confirmCutoff(side: Side, expectedState?: object): boolean {
  const state = getState()[side]
  if ((expectedState != null && state !== expectedState) || !state.blocked) return false
  state.cutoffPending = false
  return true
}

/** Attach a restart-orphan lookup result to its still-live resolution. */
export function identifyResolution(side: Side, expectedState: object, alertId: number): boolean {
  const state = getState()[side]
  if (state !== expectedState || !state.resolutionPending) return false
  state.activeAlertId = alertId
  return true
}

/**
 * Perform the one guard-authorized duration write for a manual resolution.
 * Ordinary writers remain blocked for the entire operation.
 */
export async function restoreAcknowledgedSession(
  side: Side,
  restore: PumpStallRestore,
  expectedState: object,
): Promise<void> {
  let wrote = false
  await withSideLock(side, async () => {
    const state = getState()[side]
    if (state !== expectedState || !state.resolutionPending) {
      throw new Error('pump-stall resolution was superseded before restore')
    }
    const client = getSharedHardwareClient()
    await client.setTemperature(side, restore.targetTemperature, restore.durationSeconds)
    wrote = true
  })
  if (!wrote) throw new Error('pump-stall restore did not reach hardware')

  try {
    db
      .update(deviceState)
      .set({
        isPowered: true,
        poweredOnAt: new Date(),
        targetTemperature: restore.targetTemperature,
        lastUpdated: new Date(),
      })
      .where(eq(deviceState.side, side))
      .run()
  }
  catch (err) {
    console.warn('[pumpStallGuard] manual restore device_state update failed:', err instanceof Error ? err.message : err)
  }
}

/** Finish a manual resolution without clobbering a superseding transition. */
export function completeResolution(side: Side, expectedState: object): boolean {
  const state = getState()[side]
  if (state !== expectedState || !state.resolutionPending) return false
  reset(side)
  return true
}

// ── Alert row supersede ────────────────────────────────────────────────────

/**
 * Stamp `dismissedAt` on still-active `power_off` rows for a side. The
 * newest incident supersedes older ones — one physical pump per side means
 * two active rows can only be duplicates of the same fault lineage, and
 * rows left active forever resurrect stale blocks at every boot via
 * rehydrate(). Bounds are keyed on id, never timestamp: ids are monotonic
 * under the pre-NTP clock skew pod boots routinely see. Best-effort like
 * every other alert stamp; returns the number of rows stamped.
 */
export function supersedeAlerts(side: Side, bound?: { beforeId?: number, throughId?: number }): number {
  const conditions = [
    eq(pumpAlerts.side, side),
    eq(pumpAlerts.action, 'power_off'),
    isNull(pumpAlerts.acknowledgedAt),
    isNull(pumpAlerts.dismissedAt),
  ]
  if (bound?.beforeId != null) conditions.push(lt(pumpAlerts.id, bound.beforeId))
  if (bound?.throughId != null) conditions.push(lte(pumpAlerts.id, bound.throughId))
  try {
    const result = biometricsDb
      .update(pumpAlerts)
      .set({ dismissedAt: new Date() })
      .where(and(...conditions))
      .run()
    return result.changes
  }
  catch (err) {
    console.warn('[pumpStallGuard] alert supersede failed:', err instanceof Error ? err.message : err)
    return 0
  }
}

// ── Feature stand-down (protection disabled) ───────────────────────────────

/**
 * Stand the guard down entirely when stall protection is switched off.
 * A plain reset() would abandon an unconfirmed cutoffPending retry — the
 * only thing still trying to de-energize a side that may sit against a
 * stalled pump — so each such side gets one final best-effort power-off
 * first. State and notices are then cleared and all active power_off rows
 * dismissed, so nothing resurrects a block after a later re-enable.
 */
export async function standDown(): Promise<void> {
  for (const side of ['left', 'right'] as Side[]) {
    const state = getState()[side]
    if (state.cutoffPending || state.probeStartedAt != null || state.resolutionPending) {
      console.warn(`[pumpStallGuard] standing down ${side} with hardware not confirmed off — attempting final power-off`)
      try {
        await withSideLock(side, async () => {
          const client = getSharedHardwareClient()
          await client.setPower(side, false)
        })
      }
      catch (err) {
        console.warn(`[pumpStallGuard] final cutoff for ${side} failed:`, err instanceof Error ? err.message : err)
      }
    }
    reset(side)
    supersedeAlerts(side)
  }
}

// ── Startup rehydration ────────────────────────────────────────────────────

/**
 * A fault row older than this no longer describes live hardware — if the
 * pump is genuinely still stalled, the guard re-trips within dwellSamples
 * frames of the side energizing, so skipping costs seconds of exposure
 * while resurrecting costs a wrongly blocked side on every boot.
 */
const REHYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Timestamps before this predate the product — evidence of a pre-NTP
 *  write-time clock, not of staleness. */
const CLOCK_PLAUSIBILITY_FLOOR_MS = Date.UTC(2024, 0, 1)

/**
 * Restore per-side guard state from the newest still-active `power_off`
 * row. A restart wipes the in-memory block and banner while the fault row
 * (and possibly the stalled pump) persists — without this the side comes
 * back unguarded and the acknowledgement path has nothing to stamp.
 * Skipped when stall protection is disabled; DB errors warn, never throw.
 */
export function rehydrate(): void {
  const settings = readSettings()
  if (!getSettingsState().lastReadAvailable || !settings.enabled) return
  for (const side of ['left', 'right'] as Side[]) {
    const state = getState()[side]
    if (state.blocked || state.activeAlertId != null) continue

    let row
    try {
      [row] = biometricsDb
        .select({
          id: pumpAlerts.id,
          timestamp: pumpAlerts.timestamp,
          rpm: pumpAlerts.rpm,
          restoreTargetTemperature: pumpAlerts.restoreTargetTemperature,
          restoreDurationSeconds: pumpAlerts.restoreDurationSeconds,
        })
        .from(pumpAlerts)
        .where(and(
          eq(pumpAlerts.side, side),
          eq(pumpAlerts.action, 'power_off'),
          isNull(pumpAlerts.acknowledgedAt),
          isNull(pumpAlerts.dismissedAt),
        ))
        // Newest by id, not timestamp: ids are AUTOINCREMENT-monotonic in
        // true incident order, while wall-clock timestamps invert under the
        // pre-NTP boot skew — and the supersede bounds below key on id, so
        // selecting by anything else would leave rows the drain never
        // reaches.
        .orderBy(desc(pumpAlerts.id))
        .limit(1)
        .all()
    }
    catch (err) {
      console.warn('[pumpStallGuard] rehydration read failed:', err instanceof Error ? err.message : err)
      continue
    }
    if (!row) continue

    // Age gate, the last-resort staleness backstop. Signed comparison so a
    // future-timestamped row (trip recorded under a skewed pre-NTP boot
    // clock) counts as fresh and fails toward blocking. The plausibility
    // floor covers the opposite skew: a near-epoch timestamp means the trip
    // was recorded before the clock ever synced — its true age is
    // unknowable, so it also counts as fresh rather than bulk-dismissing
    // what may be a minutes-old fault.
    const ageMs = Date.now() - row.timestamp.getTime()
    if (ageMs > REHYDRATE_MAX_AGE_MS && row.timestamp.getTime() >= CLOCK_PLAUSIBILITY_FLOOR_MS) {
      const stamped = supersedeAlerts(side, { throughId: row.id })
      console.warn(`[pumpStallGuard] skipped rehydration for ${side}: alert ${row.id} is ${Math.round(ageMs / 86_400_000)}d old — dismissed ${stamped} stale row(s)`)
      continue
    }

    // Older active rows can never be the incident this block represents —
    // stamp them now so resolving this one drains the whole backlog
    // instead of resurrecting the next-newest row at every boot.
    supersedeAlerts(side, { beforeId: row.id })

    const restore = row.restoreTargetTemperature != null && row.restoreDurationSeconds != null
      ? { targetTemperature: row.restoreTargetTemperature, durationSeconds: row.restoreDurationSeconds }
      : null
    state.blocked = true
    state.trippedAt = row.timestamp.getTime()
    state.activeAlertId = row.id
    state.preStall = restore
    state.rehydrated = true
    setPumpStallNotice(side, {
      alertId: row.id,
      trippedAt: Math.floor(row.timestamp.getTime() / 1000),
      rpm: row.rpm ?? 0,
      restore,
    })
    console.warn(`[pumpStallGuard] rehydrated active stall for ${side} from alert ${row.id} — blocked until acknowledged`)
  }
}

// ── Test / runtime reset ───────────────────────────────────────────────────

export function reset(side?: Side): void {
  if (side) {
    getState()[side] = emptyState()
    clearPumpStallNotice(side)
    return
  }
  const all = getState()
  all.left = emptyState()
  all.right = emptyState()
  clearPumpStallNotice('left')
  clearPumpStallNotice('right')
}

// ── Internals ──────────────────────────────────────────────────────────────

async function trip(side: Side, rpm: number, trippedAt: number): Promise<void> {
  const state = getState()[side]
  state.blocked = true
  state.trippedAt = trippedAt
  state.consecutiveLowFrames = 0
  state.consecutiveHealthyFrames = 0
  state.lowSince = null
  state.recoveryAttempts = 0
  state.probeStartedAt = null
  state.lastProbeEndedAt = null
  state.resolutionPending = false
  // A fresh trip must never inherit a lingering rehydrated flag (e.g. left
  // behind by the disabled branch) — it would satisfy the self-release
  // gate that only stale, restored blocks may use.
  state.rehydrated = false

  // Only a live firmware countdown is a truthful restore snapshot. Inferring
  // an 8-hour window from device_state.poweredOnAt made short restored
  // sessions produce alert rows claiming ~28,700 seconds remained. When the
  // frame path has no countdown, persist no restore instead of fabricating one.

  // Mirror the database state before the hardware write — same ordering as
  // the router power-off path (see sideLock.ts): a queued same-side writer
  // that acquires the lock after the cutoff observes isPowered=false and
  // skips.
  try {
    db
      .update(deviceState)
      .set({
        isPowered: false,
        poweredOnAt: null,
        targetTemperature: null,
        lastUpdated: new Date(),
      })
      .where(eq(deviceState.side, side))
      .run()
  }
  catch (err) {
    console.warn('[pumpStallGuard] device_state update failed:', err instanceof Error ? err.message : err)
  }

  let alertId = 0
  try {
    const inserted = biometricsDb
      .insert(pumpAlerts)
      .values({
        timestamp: new Date(state.trippedAt),
        type: side === 'left' ? 'stall_left' : 'stall_right',
        side,
        rpm,
        action: 'power_off',
        restoreTargetTemperature: state.preStall?.targetTemperature ?? null,
        restoreDurationSeconds: state.preStall?.durationSeconds ?? null,
      })
      .returning({ id: pumpAlerts.id })
      .all()
    alertId = inserted[0]?.id ?? 0
  }
  catch (err) {
    console.error('[pumpStallGuard] pump_alerts insert failed:', err instanceof Error ? err.message : err)
  }

  state.activeAlertId = alertId || null

  // A new incident supersedes any still-active older rows for this side.
  // Only when this insert landed: on insert failure the older rows are the
  // surviving persistent trace of the fault.
  if (alertId) supersedeAlerts(side, { beforeId: alertId })

  // Publish the banner before any await: against unresponsive firmware the
  // cutoff below can block for the full DAC timeout, and commands rejected
  // during that window need the notice to explain why. An acknowledge()
  // racing the cutoff clears the notice after this point, so it always wins.
  setPumpStallNotice(side, {
    alertId,
    trippedAt: Math.floor(state.trippedAt / 1000),
    rpm,
    restore: state.preStall,
  })

  console.warn(`[pumpStallGuard] tripped ${side} at ${rpm} rpm — powering off until acknowledged`)

  // Power-off via the shared hardware client, bypassing the router gate
  // (the gate consults shouldBlock(side), which is already true). Serialized
  // through withSideLock so the cutoff cannot interleave with a queued
  // same-side writer's command sequence. Deadlock analysis: trip() is only
  // reachable from the frame path (deviceStateSync.runStallGuard → onFrame),
  // never from a caller already holding the same-side lock.
  //
  // cutoffPending covers the whole in-flight window, not just the failure:
  // the awaited write can block for a full DAC timeout, and a dismissal
  // landing mid-flight must see an unconfirmed cutoff and refuse to
  // release. Resolution goes through the live state — a mid-flight
  // acknowledge replaces the state object, and this incident's flag must
  // not leak onto whatever replaced it.
  state.cutoffPending = true
  try {
    await withSideLock(side, async () => {
      const client = getSharedHardwareClient()
      await client.setPower(side, false)
    })
    const live = getState()[side]
    if (live === state || (live.blocked && live.activeAlertId === state.activeAlertId)) {
      live.cutoffPending = false
    }
  }
  catch (err) {
    console.error('[pumpStallGuard] hardware power-off failed:', err instanceof Error ? err.message : err)
  }
}

/** Called under the side lock, after any queued operator OFF has landed. */
function releaseSupersededRecovery(side: Side, state: GuardState): boolean {
  if (getLastSideMutationAt(side) <= (state.trippedAt ?? 0)) return false
  // Ordinary energizing commands are blocked during an incident. A newer
  // successful mutation therefore supersedes recovery with the operator's OFF.
  if (state.activeAlertId != null) {
    try {
      biometricsDb.update(pumpAlerts)
        .set({ acknowledgedAt: new Date() })
        .where(and(
          eq(pumpAlerts.id, state.activeAlertId),
          isNull(pumpAlerts.acknowledgedAt),
          isNull(pumpAlerts.dismissedAt),
        ))
        .run()
    }
    catch (err) {
      console.warn('[pumpStallGuard] alert update failed:', err instanceof Error ? err.message : err)
    }
    supersedeAlerts(side, { beforeId: state.activeAlertId })
  }
  reset(side)
  console.log(`[pumpStallGuard] auto-recover for ${side} superseded by a newer command — standing down`)
  return true
}

async function autoRecover(side: Side, now: number): Promise<void> {
  const state = getState()[side]
  // Never clear the guard while the trip-time cutoff is still unsent: the
  // side may be energized against the pump, and reset() would abandon the
  // per-frame retry that is the only thing still trying to turn it off.
  // The retry runs before recovery tracking, so once it lands a later
  // healthy frame re-enters here with the flag cleared.
  if (state.cutoffPending) return
  const restore = remainingPumpStallRestore(state.preStall, state.trippedAt, now)
  if (!restore) {
    // A probe can cross the original session end while collecting healthy
    // frames. Confirm an active probe is off before retiring the incident.
    // Passive healthy-RPM proof predates probes and does not itself energize
    // hardware, so it needs no compensating power-off.
    if (state.probeStartedAt != null
      && !await parkRecoveryProbe(side, state, 'expired recovery')) return
    stampAlertAutoRecovered(side, state.activeAlertId)
    reset(side)
    console.log(`[pumpStallGuard] auto-recovered ${side} — original session expired, leaving off`)
    return
  }

  // Same lock + deadlock rationale as the trip() cutoff: only reachable from
  // the frame path, and the restore sequence must not interleave with a
  // queued same-side writer. Keep the powered mirror inside that lock too.
  try {
    await withSideLock(side, async () => {
      if (getState()[side] !== state || !state.blocked) return
      if (releaseSupersededRecovery(side, state)) return
      const client = getSharedHardwareClient()
      // setPower(on) delegates to setTemperature without a duration, emitting
      // a contradictory 28,800-second session before the real duration. One
      // duration-bearing write is sufficient to energize and restore.
      await client.setTemperature(side, restore.targetTemperature, restore.durationSeconds)
      if (getState()[side] !== state || !state.blocked) return
      try {
        db
          .update(deviceState)
          .set({
            isPowered: true,
            poweredOnAt: new Date(now),
            targetTemperature: restore.targetTemperature,
            lastUpdated: new Date(now),
          })
          .where(eq(deviceState.side, side))
          .run()
      }
      catch (err) {
        console.warn('[pumpStallGuard] device_state restore failed:', err instanceof Error ? err.message : err)
      }
    })
  }
  catch (err) {
    console.error('[pumpStallGuard] auto-recover hardware call failed:', err instanceof Error ? err.message : err)
    return
  }

  if (getState()[side] !== state || !state.blocked) return

  stampAlertAutoRecovered(side, state.activeAlertId)

  reset(side)
  console.log(`[pumpStallGuard] auto-recovered ${side}`)
}

/** Start a bounded, opt-in recovery attempt after its backoff. */
async function startRecoveryProbe(side: Side, now: number): Promise<void> {
  const state = getState()[side]
  if (!state.preStall) {
    // Without a truthful duration snapshot there is no safe command to probe
    // with. Keep the fail-safe block until a human acknowledges it.
    state.recoveryAttempts = PROBE_BACKOFFS_MS.length
    console.warn(`[pumpStallGuard] cannot probe ${side} recovery without a session snapshot — staying off until acknowledged`)
    return
  }

  const restore = remainingPumpStallRestore(state.preStall, state.trippedAt, now)
  if (!restore) {
    stampAlertAutoRecovered(side, state.activeAlertId)
    reset(side)
    console.log(`[pumpStallGuard] auto-recovered ${side} — original session expired, leaving off`)
    return
  }

  state.recoveryAttempts += 1
  state.probeStartedAt = now
  state.consecutiveHealthyFrames = 0
  const probeDurationSeconds = Math.min(
    restore.durationSeconds,
    Math.ceil(PROBE_WINDOW_MS / 1000),
  )

  try {
    await withSideLock(side, async () => {
      if (getState()[side] !== state || !state.blocked || state.probeStartedAt !== now) return
      if (releaseSupersededRecovery(side, state)) return
      const client = getSharedHardwareClient()
      // A short duration is a crash-safe lease: if this process dies during
      // the probe, firmware stops it at the probe-window boundary.
      await client.setTemperature(side, restore.targetTemperature, probeDurationSeconds)
    })
  }
  catch (err) {
    if (getState()[side] === state && state.blocked) {
      // A duration write can fail after partially energizing the side. Keep
      // dismissal gated until the compensating power-off is confirmed.
      state.cutoffPending = true
      state.probeStartedAt = null
      state.lastProbeEndedAt = now
      state.consecutiveHealthyFrames = 0
    }
    await parkRecoveryProbe(side, state, 'failed recovery-probe energize')
    console.warn(`[pumpStallGuard] recovery probe energize for ${side} failed:`, err instanceof Error ? err.message : err)
    return
  }

  if (getState()[side] === state && state.blocked && state.probeStartedAt === now) {
    console.log(`[pumpStallGuard] probing ${side} recovery (attempt ${state.recoveryAttempts}/${PROBE_BACKOFFS_MS.length})`)
  }
}

/** End a probe that did not produce sustained healthy RPM. */
async function endFailedProbe(side: Side, now: number): Promise<void> {
  const state = getState()[side]
  // Keep the incident non-dismissible across the awaited compensating
  // power-off. Clearing probeStartedAt alone would publish a false-safe gap.
  state.cutoffPending = true
  state.probeStartedAt = null
  state.lastProbeEndedAt = now
  state.consecutiveHealthyFrames = 0

  if (!await parkRecoveryProbe(side, state, 'failed recovery probe')) return

  if (state.recoveryAttempts >= PROBE_BACKOFFS_MS.length) {
    console.warn(`[pumpStallGuard] ${side} pump still stalled after ${state.recoveryAttempts} recovery probes — staying off until acknowledged`)
  }
  else {
    console.log(`[pumpStallGuard] ${side} recovery probe ${state.recoveryAttempts} did not restore flow — backing off`)
  }
}

/** Power off an active/partial probe without touching a superseding incident. */
async function parkRecoveryProbe(side: Side, state: GuardState, context: string): Promise<boolean> {
  try {
    let live = false
    await withSideLock(side, async () => {
      if (getState()[side] !== state || !state.blocked) return
      live = true
      const client = getSharedHardwareClient()
      await client.setPower(side, false)
    })
    if (!live) return false
    state.cutoffPending = false
    return true
  }
  catch (err) {
    if (getState()[side] === state && state.blocked) state.cutoffPending = true
    console.warn(`[pumpStallGuard] ${context} power-off for ${side} failed:`, err instanceof Error ? err.message : err)
    return false
  }
}

function stampAlertAutoRecovered(side: Side, alertId: number | null): void {
  if (alertId == null) return
  try {
    // Guard on the untouched row like the router's acknowledge path — a
    // user acknowledgement racing this write must not be relabeled.
    biometricsDb
      .update(pumpAlerts)
      .set({ action: 'auto_recovered', acknowledgedAt: new Date() })
      .where(and(
        eq(pumpAlerts.id, alertId),
        isNull(pumpAlerts.acknowledgedAt),
        isNull(pumpAlerts.dismissedAt),
      ))
      .run()
  }
  catch (err) {
    console.warn('[pumpStallGuard] alert update failed:', err instanceof Error ? err.message : err)
  }
  supersedeAlerts(side, { beforeId: alertId })
}

/**
 * Clear a rehydrated block whose pump has held recovery speed for the full
 * healthy-frame window. No hardware call — the side keeps whatever state
 * the firmware is running; only the stale block and its rows are retired.
 */
function releaseRehydratedBlock(side: Side): void {
  const state = getState()[side]
  stampAlertAutoRecovered(side, state.activeAlertId)
  reset(side)
  console.log(`[pumpStallGuard] released rehydrated block for ${side} — pump verified healthy`)
}

// ── Test introspection ─────────────────────────────────────────────────────

export const __test__ = {
  getState,
  getSettingsState,
  emptyState,
  readSettings,
  DWELL_MIN_MS,
  FRAME_GAP_RESET_MS,
  BILATERAL_ONSET_WINDOW_MS,
  BILATERAL_DWELL_MIN_MS,
  PROBE_BACKOFFS_MS,
  PROBE_WINDOW_MS,
}
