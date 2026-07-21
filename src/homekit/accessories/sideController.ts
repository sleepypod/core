/**
 * Per-side hardware-write coordinator for HomeKit accessories.
 *
 * The Thermostat and PowerSwitch surfaces both write to the same pod side.
 * iOS can dispatch parallel onSet callbacks (batched writes from scenes,
 * automations, or near-simultaneous user gestures), so any non-serialized
 * caller can race another and stomp the user's setpoint:
 *
 *   t0  user drags slider to 78°F
 *   t1  TargetTemperature.onSet → setTemperature(side, 78)        ──┐
 *   t2  TargetHeatingCoolingState.onSet → reads stale 70°F target  │ concurrent
 *   t3  setPower(side, true, 70) → setTemperature(side, 70)       ──┘
 *
 * This module funnels every hardware write through the shared per-side hardware
 * lock, and keeps an in-process cache of the user's last requested target so
 * the power-on path doesn't depend on firmware preserving targetTemperature
 * across off-cycles.
 */

import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import { MAX_TEMP, MIN_TEMP, TEMP_NEUTRAL } from '@/src/hardware/types'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { getAutomationEngineIfRunning } from '@/src/automation'
import { withSideLock } from '@/src/hardware/sideLock'
import { shouldBlock as pumpStallShouldBlock } from '@/src/hardware/pumpStallGuard'

/**
 * HomeKit must honor the pump stall guard like every other write surface
 * (device router, keepalive). Without this gate a guard-blocked side could
 * be silently re-powered from the Home app — re-heating a side with zero
 * flow and defeating the fail-safe. Powering OFF is never gated: it is the
 * safe direction and the guard's own trip path uses it.
 */
function assertNotGuardBlocked(side: Side, label: string): void {
  if (!pumpStallShouldBlock(side)) return
  console.warn(`[homekit] refused ${label} — pump stall protection active on ${side}`)
  throw new Error('Pump stall protection active — acknowledge the alert first')
}

const lastTargetF: Record<Side, number | null> = { left: null, right: null }

// Intended power state as expressed by HomeKit, updated eagerly. Used to
// resolve the "user dragged the slider mid-power-cycle" race: firmware
// status reads lag behind writes, so isCurrentlyPowered alone can return
// the pre-toggle value and silently swallow the queued setTemperature.
const intendedPower: Record<Side, boolean | null> = { left: null, right: null }

function registerManualOverride(side: Side): void {
  getAutomationEngineIfRunning()?.registerManualOverride(side)
}

async function logged<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  }
  catch (e) {
    console.warn(`[homekit] ${label} failed:`, e instanceof Error ? e.message : e)
    throw e
  }
}

function clampF(f: number): number {
  return Math.min(MAX_TEMP, Math.max(MIN_TEMP, f))
}

export function isPoweredFromStatus(status: DeviceStatus, side: Side): boolean {
  const s = side === 'left' ? status.leftSide : status.rightSide
  return s.targetLevel !== 0
}

export function isCurrentlyPowered(monitor: DacMonitor, side: Side): boolean {
  const status = monitor.getLastStatus()
  return status ? isPoweredFromStatus(status, side) : false
}

/**
 * What HomeKit OnGet should report. Prefers the user's most recent intent
 * (set eagerly by setSidePowerOn / setSidePowerOff) over firmware status,
 * which lags by a poll interval. Without this, toggling AUTO can briefly
 * read back as OFF in iOS Home until the next status update arrives.
 */
export function isEffectivelyPowered(monitor: DacMonitor, side: Side): boolean {
  const intended = intendedPower[side]
  if (intended !== null) return intended
  return isCurrentlyPowered(monitor, side)
}

/**
 * Reconcile the intent latch with observed firmware state. Once firmware
 * reports the side in the intended power state, the intent has been realized
 * and firmware becomes the source of truth again. Without this, the latch
 * shadowed every external power transition (scheduler off, auto-off, pump
 * stall guard) forever: isEffectivelyPowered kept reporting stale ON and
 * setTargetTemperature could re-heat a bed the scheduler had shut off.
 * While intent and status still disagree, the write is presumed in flight
 * (status lags a poll interval) and the latch is kept.
 */
export function reconcileIntendedPower(status: DeviceStatus, side: Side): void {
  const intended = intendedPower[side]
  if (intended === null) return
  if (isPoweredFromStatus(status, side) === intended) {
    intendedPower[side] = null
  }
}

/**
 * Resolve the target setpoint to use when powering a side back on.
 * Cache wins because firmware may not preserve targetTemperature across
 * a level=0 (off) write. Falls back to the last firmware status, then to
 * NEUTRAL so a power-on without any prior context lands on a safe value
 * instead of the hardware client's hardcoded 75°F default.
 */
export function getStagedTargetF(monitor: DacMonitor, side: Side): number {
  const cached = lastTargetF[side]
  if (cached !== null) return cached
  const status = monitor.getLastStatus()
  if (!status) return TEMP_NEUTRAL
  const s = side === 'left' ? status.leftSide : status.rightSide
  return s.targetTemperature ?? TEMP_NEUTRAL
}

/**
 * Apply a user-requested target temperature.
 * - Always update the in-process cache eagerly (so a queued power-on sees it).
 * - Push to firmware only if the side is currently powered. Adjusting the
 *   slider while OFF stages the value without forcing a power-on, which
 *   matches iOS Home thermostat-tile semantics. Power resumes through
 *   TargetHeatingCoolingState or the dedicated Power switch.
 *
 * f is captured in closure so back-to-back drags of the slider each push
 * their own value, even though the cache only retains the latest.
 */
export async function setTargetTemperature(
  monitor: DacMonitor,
  side: Side,
  requestedF: number,
): Promise<void> {
  const f = clampF(requestedF)
  lastTargetF[side] = f
  await withSideLock(side, async () => {
    const intended = intendedPower[side]
    const powered = intended !== null ? intended : isCurrentlyPowered(monitor, side)
    if (!powered) return
    // Gate only the firmware push: staging a target on an off side is
    // harmless, and the guard trip leaves the intent latch stuck ON
    // (firmware never confirms), so `powered` alone can't be trusted here.
    assertNotGuardBlocked(side, `setTemperature(${side}, ${f})`)
    registerManualOverride(side)
    await logged(
      `setTemperature(${side}, ${f})`,
      () => getSharedHardwareClient().setTemperature(side, f),
    )
  })
}

/**
 * Power a side on, preserving the user's last requested target.
 * Shared by the Thermostat's TargetHeatingCoolingState=AUTO path and the
 * Power switch's On=true path so both surfaces stay in lockstep.
 *
 * On rejection, intendedPower is rolled back to its prior value so a
 * subsequent setTargetTemperature doesn't push a write against firmware
 * that the failed power-on left in an unknown state.
 */
export async function setSidePowerOn(monitor: DacMonitor, side: Side): Promise<void> {
  assertNotGuardBlocked(side, `setPower(${side}, true)`)
  const prev = intendedPower[side]
  intendedPower[side] = true
  try {
    await withSideLock(side, async () => {
      const target = clampF(getStagedTargetF(monitor, side))
      lastTargetF[side] = target
      registerManualOverride(side)
      await logged(
        `setPower(${side}, true, ${target})`,
        () => getSharedHardwareClient().setPower(side, true, target),
      )
    })
  }
  catch (e) {
    intendedPower[side] = prev
    throw e
  }
}

export async function setSidePowerOff(monitor: DacMonitor, side: Side): Promise<void> {
  const prev = intendedPower[side]
  intendedPower[side] = false
  try {
    await withSideLock(side, () => logged(
      `setPower(${side}, false)`,
      () => {
        registerManualOverride(side)
        return getSharedHardwareClient().setPower(side, false)
      },
    ))
  }
  catch (e) {
    intendedPower[side] = prev
    throw e
  }
}

/**
 * Test-only: clear cached target and intent state.
 * Module-level state survives across tests in the same file otherwise.
 */
export function __resetSideController(): void {
  lastTargetF.left = null
  lastTargetF.right = null
  intendedPower.left = null
  intendedPower.right = null
}
