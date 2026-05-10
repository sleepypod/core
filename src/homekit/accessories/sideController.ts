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
 * This module funnels every hardware write through a per-side promise queue,
 * and keeps an in-process cache of the user's last requested target so the
 * power-on path doesn't depend on firmware preserving targetTemperature
 * across off-cycles.
 */

import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import { MAX_TEMP, MIN_TEMP, TEMP_NEUTRAL } from '@/src/hardware/types'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'

const lastTargetF: Record<Side, number | null> = { left: null, right: null }

// Intended power state as expressed by HomeKit, updated eagerly. Used to
// resolve the "user dragged the slider mid-power-cycle" race: firmware
// status reads lag behind writes, so isCurrentlyPowered alone can return
// the pre-toggle value and silently swallow the queued setTemperature.
const intendedPower: Record<Side, boolean | null> = { left: null, right: null }

const sideQueues: Record<Side, Promise<unknown>> = {
  left: Promise.resolve(),
  right: Promise.resolve(),
}

function serialize<T>(side: Side, fn: () => Promise<T>): Promise<T> {
  const next = sideQueues[side].then(fn, fn)
  sideQueues[side] = next.catch(() => undefined)
  return next
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
  return s.targetTemperature
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
  await serialize(side, async () => {
    const intended = intendedPower[side]
    const powered = intended !== null ? intended : isCurrentlyPowered(monitor, side)
    if (!powered) return
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
  const prev = intendedPower[side]
  intendedPower[side] = true
  try {
    await serialize(side, async () => {
      const target = clampF(getStagedTargetF(monitor, side))
      lastTargetF[side] = target
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
    await serialize(side, () => logged(
      `setPower(${side}, false)`,
      () => getSharedHardwareClient().setPower(side, false),
    ))
  }
  catch (e) {
    intendedPower[side] = prev
    throw e
  }
}

/**
 * Test-only: clear cached target and reset the side queues.
 * Module-level state survives across tests in the same file otherwise.
 */
export function __resetSideController(): void {
  lastTargetF.left = null
  lastTargetF.right = null
  intendedPower.left = null
  intendedPower.right = null
  sideQueues.left = Promise.resolve()
  sideQueues.right = Promise.resolve()
}
