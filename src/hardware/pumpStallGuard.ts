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

import { and, desc, eq, isNull } from 'drizzle-orm'
import { biometricsDb, db } from '@/src/db'
import { pumpAlerts } from '@/src/db/biometrics-schema'
import { deviceSettings, deviceState } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/sharedClient'
import { clearPumpStallNotice, setPumpStallNotice } from './pumpStallNotification'
import { withSideLock } from './sideLock'
import type { Side } from './types'

interface GuardState {
  consecutiveLowFrames: number
  consecutiveHealthyFrames: number
  blocked: boolean
  trippedAt: number | null
  /** id of the pump_alerts row written at trip — used by auto-recover to
   *  update `action` on the same row. */
  activeAlertId: number | null
  preStall: { targetTemperature: number, durationSeconds: number } | null
  /** true when the trip-time hardware power-off never went out — retried
   *  on every subsequent frame until it succeeds. */
  cutoffPending: boolean
  /** epoch ms of the first frame in the current sub-threshold run, or null
   *  when the last frame was healthy. Gates the time-based dwell floor. */
  lowSince: number | null
  /** number of auto-recovery probes started since the trip. */
  recoveryAttempts: number
  /** epoch ms the current probe re-energized the side, or null when not
   *  probing. While set, the side is physically on but the guard stays blocked
   *  until sustained healthy RPM confirms recovery. */
  probeStartedAt: number | null
  /** epoch ms the last probe was powered back off; backoff is measured from
   *  here (or the trip, for the first probe). */
  lastProbeEndedAt: number | null
}

interface GuardSettings {
  enabled: boolean
  threshold: number
  dwellSamples: number
  autoRecoveryEnabled: boolean
  recoveryRpm: number
  recoverySamples: number
}

const G = globalThis as Record<string, unknown>
const STATE_KEY = '__sp_pump_stall_guard_state__'

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
    recoveryAttempts: 0,
    probeStartedAt: null,
    lastProbeEndedAt: null,
  }
}

// Time-based dwell floor. A trip requires the pump to stay sub-threshold for
// BOTH dwellSamples consecutive frames AND this much wall-clock — so a burst
// of frames, or a ~1–2s dropped/garbled-frame blip, can't power a side off
// mid-night. A genuine stall still trips within ~10s, which is thermally
// harmless (the bed takes minutes to drift). Frame-based dwell alone tripped
// on ~2s of bad readings; see ADR 0022.
const DWELL_MIN_MS = 10_000

// Auto-recovery probe schedule. A trip powers the pump off, so RPM stays 0 and
// recovery can never be observed passively — nothing re-energizes the pump. So
// a blocked side with auto-recovery enabled is actively re-energized after each
// backoff to let the pump prove itself; sustained healthy RPM restores it,
// otherwise it is powered back off and the next (longer) backoff applies. After
// the last backoff the side stays off until the user acknowledges. Backoffs are
// spaced so an intermittent fault gets a few chances without thrashing a
// genuinely dead pump against the loop all night.
const PROBE_BACKOFFS_MS = [5 * 60_000, 15 * 60_000, 30 * 60_000]
// How long a probe keeps the pump energized waiting for sustained healthy RPM
// before concluding the pump is still stalled.
const PROBE_WINDOW_MS = 60_000

// ── Settings cache ─────────────────────────────────────────────────────────
// `recordFlowData` fires every frame; reading device_settings on each call
// would do extra SQL per second. Cache for a few seconds — settings
// mutations are rare and a short staleness window is fine for safety dwell.
const SETTINGS_TTL_MS = 5_000
let cachedSettings: { value: GuardSettings, at: number } | null = null

function readSettings(): GuardSettings {
  const now = Date.now()
  if (cachedSettings && now - cachedSettings.at < SETTINGS_TTL_MS) {
    return cachedSettings.value
  }

  let row: typeof deviceSettings.$inferSelect | undefined
  try {
    [row] = db.select().from(deviceSettings).limit(1).all()
  }
  catch (err) {
    console.warn('[pumpStallGuard] failed to read settings, using defaults:', err instanceof Error ? err.message : err)
  }

  const value: GuardSettings = {
    // Fail-safe-off: an opt-in power-cutting feature must never arm on missing
    // data. Matches the schema/seed/router default and the 0012 backfill — the
    // only way to reach this fallback is a degraded read (row undefined).
    enabled: row?.pumpStallProtectionEnabled ?? false,
    threshold: row?.pumpStallRpmThreshold ?? 500,
    dwellSamples: row?.pumpStallDwellSamples ?? 2,
    autoRecoveryEnabled: row?.pumpStallAutoRecoveryEnabled ?? false,
    recoveryRpm: row?.pumpStallRecoveryRpm ?? 1500,
    recoverySamples: row?.pumpStallRecoverySamples ?? 3,
  }
  cachedSettings = { value, at: now }
  return value
}

/** Invalidate the settings cache; call after a device_settings mutation. */
export function invalidateGuardSettingsCache(): void {
  cachedSettings = null
}

// ── Per-frame entry point ──────────────────────────────────────────────────

export interface OnFrameInput {
  side: Side
  rpm: number
  expectedActive: boolean
  preStallTarget: number | null
  preStallDurationSeconds: number | null
  /** Frame receipt time (epoch ms) for the dwell floor; defaults to now.
   *  Threaded so the time-based dwell is driven by frame arrival, not the
   *  guard's own clock, and stays deterministic under test. */
  now?: number
}

export async function onFrame(input: OnFrameInput): Promise<void> {
  const settings = readSettings()
  const state = getState()[input.side]
  const now = input.now ?? Date.now()

  if (!settings.enabled) {
    state.consecutiveLowFrames = 0
    state.consecutiveHealthyFrames = 0
    state.blocked = false
    state.lowSince = null
    return
  }

  if (!input.expectedActive && !state.blocked) {
    // Side commanded off — RPM of zero is the correct state, don't penalize.
    // A blocked side falls through: trip() mirrors isPowered=false, so
    // expectedActive is false for every post-trip frame and returning here
    // would make the cutoff retry and recovery tracking below unreachable.
    state.consecutiveLowFrames = 0
    state.lowSince = null
    return
  }

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
      state.consecutiveLowFrames += 1
      if (state.lowSince == null) state.lowSince = now
      // Require both the frame-count dwell and the wall-clock floor so a brief
      // burst of low frames can't trip on its own (see DWELL_MIN_MS).
      if (state.consecutiveLowFrames >= settings.dwellSamples
        && now - state.lowSince >= DWELL_MIN_MS) {
        await trip(input.side, input.rpm)
      }
    }
    else {
      state.consecutiveLowFrames = 0
      state.lowSince = null
    }
    return
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

  // Auto-recovery (opt-in). A trip powers the pump off, so RPM sits at 0 and
  // recovery cannot be observed passively — nothing re-energizes the pump to
  // let it prove itself. Instead, after a backoff, actively re-energize the
  // side (a "probe"); the healthy-frame tracking below then sees whether the
  // pump recovers. See PROBE_BACKOFFS_MS.
  if (!settings.autoRecoveryEnabled) return

  if (input.rpm >= settings.recoveryRpm) {
    state.consecutiveHealthyFrames += 1
  }
  else {
    state.consecutiveHealthyFrames = 0
  }
  if (state.consecutiveHealthyFrames >= settings.recoverySamples) {
    await autoRecover(input.side)
    return
  }

  // Don't probe while a failed trip-cutoff is still being retried — the side
  // must reach a known-off state first.
  if (state.cutoffPending) return

  if (state.probeStartedAt == null) {
    // Idle between probes: start one when the backoff has elapsed and attempts
    // remain. Backoff runs from the last probe's end, or the trip.
    if (state.recoveryAttempts < PROBE_BACKOFFS_MS.length) {
      const backoff = PROBE_BACKOFFS_MS[state.recoveryAttempts]
      const since = state.lastProbeEndedAt ?? state.trippedAt ?? now
      if (now - since >= backoff) {
        await startRecoveryProbe(input.side, now)
      }
    }
  }
  else if (now - state.probeStartedAt >= PROBE_WINDOW_MS) {
    // Probe window elapsed without sustained healthy RPM — pump still stalled.
    await endFailedProbe(input.side, now)
  }
}

// ── Block decision used by setTemperature / setPower / keepalive ───────────

export function shouldBlock(side: Side): boolean {
  return getState()[side].blocked
}

// ── Manual acknowledgement (called by tRPC mutation) ───────────────────────

/**
 * Clear the guard for a side. Returns the pre-stall snapshot the caller
 * should restore via the normal command path, plus the active alert id so
 * the caller can stamp `acknowledgedAt` on the same row. Returns null
 * fields when nothing is captured.
 */
export function acknowledge(side: Side): {
  restore: { targetTemperature: number, durationSeconds: number } | null
  alertId: number | null
} {
  const state = getState()[side]
  const restore = state.preStall
  const alertId = state.activeAlertId
  getState()[side] = emptyState()
  clearPumpStallNotice(side)
  return { restore, alertId }
}

// ── Re-arm after a failed acknowledge-and-restore ──────────────────────────

/**
 * Re-block a side whose acknowledgement could not complete. acknowledge()
 * clears the guard optimistically; when the subsequent hardware restore
 * fails, the alert row is still active (nothing was stamped) and the block
 * plus banner must come back with it — otherwise the protection is
 * silently lost while the side sits in an unknown power state.
 */
export function rearm(side: Side, params: {
  alertId: number | null
  restore: { targetTemperature: number, durationSeconds: number } | null
  /** ms epoch of the original trip; defaults to now */
  trippedAt?: number
  rpm?: number
}): void {
  const state = getState()[side]
  state.blocked = true
  state.trippedAt = params.trippedAt ?? Date.now()
  state.activeAlertId = params.alertId
  state.preStall = params.restore
  state.consecutiveLowFrames = 0
  state.consecutiveHealthyFrames = 0
  state.lowSince = null
  state.recoveryAttempts = 0
  state.probeStartedAt = null
  state.lastProbeEndedAt = null
  setPumpStallNotice(side, {
    alertId: params.alertId ?? 0,
    trippedAt: Math.floor(state.trippedAt / 1000),
    rpm: params.rpm ?? 0,
    restore: params.restore,
  })
}

// ── Startup rehydration ────────────────────────────────────────────────────

/**
 * Restore per-side guard state from the newest still-active `power_off`
 * row. A restart wipes the in-memory block and banner while the fault row
 * (and possibly the stalled pump) persists — without this the side comes
 * back unguarded and the acknowledgement path has nothing to stamp.
 * Skipped when stall protection is disabled; DB errors warn, never throw.
 */
export function rehydrate(): void {
  if (!readSettings().enabled) return
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
        .orderBy(desc(pumpAlerts.timestamp), desc(pumpAlerts.id))
        .limit(1)
        .all()
    }
    catch (err) {
      console.warn('[pumpStallGuard] rehydration read failed:', err instanceof Error ? err.message : err)
      continue
    }
    if (!row) continue

    const restore = row.restoreTargetTemperature != null && row.restoreDurationSeconds != null
      ? { targetTemperature: row.restoreTargetTemperature, durationSeconds: row.restoreDurationSeconds }
      : null
    state.blocked = true
    state.trippedAt = row.timestamp.getTime()
    state.activeAlertId = row.id
    state.preStall = restore
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

async function trip(side: Side, rpm: number): Promise<void> {
  const state = getState()[side]
  state.blocked = true
  state.trippedAt = Date.now()
  state.consecutiveLowFrames = 0
  state.consecutiveHealthyFrames = 0
  state.lowSince = null

  // Capture a snapshot from device_state if we don't already have one — the
  // preStall field is updated each healthy frame, but covers the case where
  // the guard starts already stalled.
  if (!state.preStall) {
    try {
      const [row] = db
        .select({ target: deviceState.targetTemperature })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()
      if (row?.target != null) {
        state.preStall = { targetTemperature: row.target, durationSeconds: 28800 }
      }
    }
    catch (err) {
      console.warn('[pumpStallGuard] device_state snapshot read failed:', err instanceof Error ? err.message : err)
    }
  }

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
  try {
    await withSideLock(side, async () => {
      const client = getSharedHardwareClient()
      await client.setPower(side, false)
    })
  }
  catch (err) {
    state.cutoffPending = true
    console.error('[pumpStallGuard] hardware power-off failed:', err instanceof Error ? err.message : err)
  }
}

async function autoRecover(side: Side): Promise<void> {
  const state = getState()[side]
  const restore = state.preStall
  if (!restore) {
    // No snapshot to restore — leave the side off and clear the guard so
    // the next user command isn't blocked. This is the conservative path.
    reset(side)
    return
  }

  // Same lock + deadlock rationale as the trip() cutoff: only reachable from
  // the frame path, and the restore sequence must not interleave with a
  // queued same-side writer.
  try {
    await withSideLock(side, async () => {
      const client = getSharedHardwareClient()
      await client.setPower(side, true, restore.targetTemperature)
      await client.setTemperature(side, restore.targetTemperature, restore.durationSeconds)
    })
  }
  catch (err) {
    console.error('[pumpStallGuard] auto-recover hardware call failed:', err instanceof Error ? err.message : err)
    return
  }

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
    console.warn('[pumpStallGuard] device_state restore failed:', err instanceof Error ? err.message : err)
  }

  if (state.activeAlertId != null) {
    try {
      biometricsDb
        .update(pumpAlerts)
        .set({ action: 'auto_recovered', acknowledgedAt: new Date() })
        .where(eq(pumpAlerts.id, state.activeAlertId))
        .run()
    }
    catch (err) {
      console.warn('[pumpStallGuard] alert update failed:', err instanceof Error ? err.message : err)
    }
  }

  reset(side)
  console.log(`[pumpStallGuard] auto-recovered ${side}`)
}

/**
 * Re-energize a blocked side so its pump can attempt to spin back up. The guard
 * stays blocked and device_state keeps mirroring off — only sustained healthy
 * RPM (observed by onFrame → autoRecover) actually restores the side. If the
 * pump stays low for the probe window, endFailedProbe powers it back off.
 */
async function startRecoveryProbe(side: Side, now: number): Promise<void> {
  const state = getState()[side]
  const restore = state.preStall
  if (!restore) {
    // No snapshot to restore to — a probe can't lead anywhere. Give up and
    // clear the guard so a later user command isn't blocked (mirrors the
    // no-snapshot autoRecover path).
    reset(side)
    return
  }

  state.recoveryAttempts += 1
  state.probeStartedAt = now
  state.consecutiveHealthyFrames = 0

  // Same lock + deadlock rationale as trip()/autoRecover: only reachable from
  // the frame path, and the energize must not interleave with a queued
  // same-side writer's command sequence.
  try {
    await withSideLock(side, async () => {
      const client = getSharedHardwareClient()
      await client.setPower(side, true, restore.targetTemperature)
      await client.setTemperature(side, restore.targetTemperature, restore.durationSeconds)
    })
  }
  catch (err) {
    // Couldn't energize — count it as a failed probe so the backoff advances.
    state.probeStartedAt = null
    state.lastProbeEndedAt = now
    console.warn(`[pumpStallGuard] recovery probe energize for ${side} failed:`, err instanceof Error ? err.message : err)
    return
  }
  console.log(`[pumpStallGuard] probing ${side} recovery (attempt ${state.recoveryAttempts}/${PROBE_BACKOFFS_MS.length})`)
}

/**
 * A recovery probe elapsed without sustained healthy RPM — the pump is still
 * stalled. Power the side back off and record the end so the next (longer)
 * backoff applies; after the last attempt the side stays off until acknowledged.
 */
async function endFailedProbe(side: Side, now: number): Promise<void> {
  const state = getState()[side]
  state.probeStartedAt = null
  state.lastProbeEndedAt = now
  state.consecutiveHealthyFrames = 0

  try {
    await withSideLock(side, async () => {
      const client = getSharedHardwareClient()
      await client.setPower(side, false)
    })
  }
  catch (err) {
    console.warn(`[pumpStallGuard] recovery probe power-off for ${side} failed:`, err instanceof Error ? err.message : err)
  }

  if (state.recoveryAttempts >= PROBE_BACKOFFS_MS.length) {
    console.warn(`[pumpStallGuard] ${side} pump still stalled after ${state.recoveryAttempts} recovery probes — staying off until acknowledged`)
  }
  else {
    console.log(`[pumpStallGuard] ${side} recovery probe ${state.recoveryAttempts} did not restore flow — backing off`)
  }
}

// ── Test introspection ─────────────────────────────────────────────────────

export const __test__ = {
  getState,
  emptyState,
  readSettings,
  DWELL_MIN_MS,
  PROBE_BACKOFFS_MS,
  PROBE_WINDOW_MS,
}
