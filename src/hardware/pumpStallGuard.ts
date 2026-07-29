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
import { withSideLock } from './sideLock'
import { DEFAULT_HEATING_DURATION } from './types'
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
    rehydrated: false,
  }
}

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
}

export async function onFrame(input: OnFrameInput): Promise<void> {
  const settings = readSettings()
  const state = getState()[input.side]

  if (!settings.enabled) {
    state.consecutiveLowFrames = 0
    state.consecutiveHealthyFrames = 0
    state.blocked = false
    // The flag must fall with the block: readSettings() fails toward
    // disabled on a degraded read, and a leaked flag would let a later
    // fresh trip inherit the rehydrated self-release.
    state.rehydrated = false
    return
  }

  if (!input.expectedActive && !state.blocked) {
    // Side commanded off — RPM of zero is the correct state, don't penalize.
    // A blocked side falls through: trip() mirrors isPowered=false, so
    // expectedActive is false for every post-trip frame and returning here
    // would make the cutoff retry and recovery tracking below unreachable.
    state.consecutiveLowFrames = 0
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
      if (state.consecutiveLowFrames >= settings.dwellSamples) {
        await trip(input.side, input.rpm)
      }
    }
    else {
      state.consecutiveLowFrames = 0
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
      if (state.consecutiveLowFrames >= settings.dwellSamples) {
        state.consecutiveLowFrames = 0
        state.cutoffPending = true
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

  // Track healthy recovery frames if auto-recovery is on.
  if (input.rpm >= settings.recoveryRpm) {
    state.consecutiveHealthyFrames += 1
  }
  else {
    state.consecutiveHealthyFrames = 0
  }
  if (settings.autoRecoveryEnabled && state.consecutiveHealthyFrames >= settings.recoverySamples) {
    await autoRecover(input.side)
  }
  else if (state.rehydrated && !state.cutoffPending && state.consecutiveHealthyFrames >= settings.recoverySamples) {
    // Auto-recovery keeps first claim on the healthy-frame threshold; with
    // it disabled, a rehydrated block releases on the same evidence bar
    // without re-energizing — the pump has proven itself at recovery speed,
    // so the pre-restart fault no longer describes the hardware. Fresh
    // same-boot trips still require explicit acknowledgement.
    releaseRehydratedBlock(input.side)
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

/**
 * Release the in-memory block when a history-row dismissal names the live
 * incident. Never releases while the trip-time cutoff is unconfirmed — the
 * per-frame retry is the only thing still trying to de-energize the side,
 * and an acknowledge-style reset would abandon it.
 */
export function dismissIfActive(side: Side, alertId: number): boolean {
  const state = getState()[side]
  if (!state.blocked || state.activeAlertId !== alertId || state.cutoffPending) return false
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
  return state.blocked && state.activeAlertId === alertId && state.cutoffPending
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
    if (state.cutoffPending) {
      console.warn(`[pumpStallGuard] standing down ${side} with an unconfirmed cutoff — attempting final power-off`)
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

async function trip(side: Side, rpm: number): Promise<void> {
  const state = getState()[side]
  const trippedAt = Date.now()
  state.blocked = true
  state.trippedAt = trippedAt
  state.consecutiveLowFrames = 0
  state.consecutiveHealthyFrames = 0
  // A fresh trip must never inherit a lingering rehydrated flag (e.g. left
  // behind by the disabled branch) — it would satisfy the self-release
  // gate that only stale, restored blocks may use.
  state.rehydrated = false

  // Capture a snapshot from device_state if we don't already have one — the
  // preStall field is updated each healthy frame, but covers the case where
  // the guard starts already stalled. No live countdown exists here, so the
  // best bound is the canonical default window measured from the recorded
  // power-on; fabricating a fresh 8h re-armed sessions that ended at
  // arbitrary times. Without a power-on timestamp, capture nothing —
  // auto-recovery then clears the guard without re-energizing.
  if (!state.preStall) {
    try {
      const [row] = db
        .select({ target: deviceState.targetTemperature, poweredOnAt: deviceState.poweredOnAt })
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()
      if (row?.target != null && row.poweredOnAt != null) {
        const remaining = Math.round(
          DEFAULT_HEATING_DURATION - (trippedAt - row.poweredOnAt.getTime()) / 1000,
        )
        if (remaining > 0) {
          state.preStall = { targetTemperature: row.target, durationSeconds: remaining }
        }
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

async function autoRecover(side: Side): Promise<void> {
  const state = getState()[side]
  // Never clear the guard while the trip-time cutoff is still unsent: the
  // side may be energized against the pump, and reset() would abandon the
  // per-frame retry that is the only thing still trying to turn it off.
  // The retry runs before recovery tracking, so once it lands a later
  // healthy frame re-enters here with the flag cleared.
  if (state.cutoffPending) return
  const restore = state.preStall
  // The snapshot holds the seconds that remained when the trip landed; the
  // side then sat parked until recovery, so replaying it verbatim would run
  // past the end of the session the user actually started. Restore only the
  // un-elapsed remainder, and once the original window has lapsed treat the
  // recovery like the no-snapshot case.
  const elapsedSeconds = state.trippedAt != null ? (Date.now() - state.trippedAt) / 1000 : 0
  const leftoverSeconds = restore ? Math.round(restore.durationSeconds - elapsedSeconds) : 0
  if (!restore || leftoverSeconds <= 0) {
    // Nothing to restore — leave the side off and clear the guard so the
    // next user command isn't blocked. Stamp the alert so a restart doesn't
    // rehydrate a block the pump has already proven itself out of.
    stampAlertAutoRecovered(side, state.activeAlertId)
    reset(side)
    console.log(`[pumpStallGuard] auto-recovered ${side}${restore ? ' — original session expired, leaving off' : ''}`)
    return
  }

  // Same lock + deadlock rationale as the trip() cutoff: only reachable from
  // the frame path, and the restore sequence must not interleave with a
  // queued same-side writer.
  try {
    await withSideLock(side, async () => {
      const client = getSharedHardwareClient()
      await client.setPower(side, true, restore.targetTemperature)
      await client.setTemperature(side, restore.targetTemperature, leftoverSeconds)
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

  stampAlertAutoRecovered(side, state.activeAlertId)

  reset(side)
  console.log(`[pumpStallGuard] auto-recovered ${side}`)
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
  emptyState,
  readSettings,
}
