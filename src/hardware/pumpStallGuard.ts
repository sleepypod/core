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
    return
  }

  if (!input.expectedActive) {
    // Side commanded off — RPM of zero is the correct state, don't penalize.
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

  // Already blocked — track healthy recovery frames if auto-recovery is on.
  if (input.rpm >= settings.recoveryRpm) {
    state.consecutiveHealthyFrames += 1
  }
  else {
    state.consecutiveHealthyFrames = 0
  }
  if (settings.autoRecoveryEnabled && state.consecutiveHealthyFrames >= settings.recoverySamples) {
    await autoRecover(input.side)
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

  // Power-off via the shared hardware client, bypassing the router gate
  // (the gate consults shouldBlock(side), which is already true).
  try {
    const client = getSharedHardwareClient()
    await client.setPower(side, false)
  }
  catch (err) {
    console.error('[pumpStallGuard] hardware power-off failed:', err instanceof Error ? err.message : err)
  }

  // Mirror the database state so getStatus / UI reflect the fail-safe.
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

  setPumpStallNotice(side, {
    alertId,
    trippedAt: Math.floor(state.trippedAt / 1000),
    rpm,
    restore: state.preStall,
  })

  console.warn(`[pumpStallGuard] tripped ${side} at ${rpm} rpm — powering off until acknowledged`)
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

  try {
    const client = getSharedHardwareClient()
    await client.setPower(side, true, restore.targetTemperature)
    await client.setTemperature(side, restore.targetTemperature, restore.durationSeconds)
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

// ── Test introspection ─────────────────────────────────────────────────────

export const __test__ = {
  getState,
  emptyState,
  readSettings,
}
