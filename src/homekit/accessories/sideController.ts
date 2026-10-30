/** Serialize HomeKit target/power writes without treating intent as a hardware report. */
import { HapStatusError } from 'hap-nodejs'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { Side } from '@/src/hardware/types'
import { MAX_LEVEL, MAX_TEMP, MIN_LEVEL, MIN_TEMP } from '@/src/hardware/types'
import { getStatusRevision } from '@/src/hardware/statusRevision'
import { getTemperatureController } from '@/src/temperature/instance'
import { TemperatureBlockedError } from '@/src/temperature/controller'
import { shouldBlock as pumpStallShouldBlock } from '@/src/hardware/pumpStallGuard'
import { withSideLock } from '@/src/hardware/sideLock'
import { getJobManager } from '@/src/scheduler'
import { freshThermostatReport, THERMOSTAT_FRESH_MS } from './reportedState'

interface PowerRequest { powered: boolean }
interface PowerEvidence { powered: boolean, evidenceAt: number, expiresAt: number }
interface PowerReceipt extends PowerEvidence { revision: number | null }
interface SideState { target: number | null, pending: PowerRequest | null, receipt: PowerReceipt | null }

// HAP handlers and runtime services may live in separate Next.js bundles.
const globalState = globalThis as typeof globalThis & { __sp_homekitSideState?: Record<Side, SideState> }
const states = globalState.__sp_homekitSideState ??= {
  left: { target: null, pending: null, receipt: null },
  right: { target: null, pending: null, receipt: null },
}

/** Explicit request only; never substitute a power-on default for a report. */
export function getRequestedTargetF(side: Side): number | null {
  return states[side].target
}

function assertNotGuardBlocked(side: Side, label: string): void {
  if (!pumpStallShouldBlock(side)) return
  console.warn(`[homekit] refused ${label} — pump stall protection active on ${side}`)
  const error = new HapStatusError(-70412)
  error.message = 'Pump stall protection active — re-enable the side first'
  throw error
}

async function logged<T>(label: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  }
  catch (error) {
    console.warn(`[homekit] ${label} failed:`, error instanceof Error ? error.message : error)
    if (error instanceof TemperatureBlockedError) throw new HapStatusError(-70412)
    throw error
  }
}

// Whole Fahrenheit avoids a fractional input rounding to the firmware's neutral/OFF level.
function clampF(value: number): number {
  if (!Number.isFinite(value)) throw new HapStatusError(-70410)
  return Math.min(MAX_TEMP, Math.max(MIN_TEMP, Math.round(value)))
}

/** A fresh report wins; an acknowledged write bridges at most one short polling gap. */
function powerEvidence(monitor: DacMonitor, side: Side): PowerEvidence {
  const state = states[side]
  // A queued OFF supersedes slider gestures immediately, even before it acquires the lock.
  if (state.pending?.powered === false) return { powered: false, evidenceAt: Date.now(), expiresAt: Date.now() }
  const observation = freshThermostatReport(monitor)
  if (observation) {
    state.receipt = null
    const reported = observation.status[side === 'left' ? 'leftSide' : 'rightSide']
    const level = reported.targetLevel, duration = reported.heatingDuration
    if (!Number.isInteger(level) || level < MIN_LEVEL || level > MAX_LEVEL
      || !Number.isSafeInteger(duration) || duration < 0) throw new HapStatusError(-70402)
    // A retained target without a live countdown does not establish a heating session.
    const expiresAt = observation.observedAt + Math.min(THERMOSTAT_FRESH_MS, duration * 1000)
    return { powered: level !== 0 && Date.now() < expiresAt, evidenceAt: observation.observedAt, expiresAt }
  }
  const receipt = state.receipt, now = Date.now()
  if (receipt && receipt.revision !== null && receipt.revision === getStatusRevision()
    && monitor.getStatus() === 'running' && now >= receipt.evidenceAt && now < receipt.expiresAt) {
    return receipt
  }
  state.receipt = null
  throw new HapStatusError(-70402)
}

/** Use the explicit staged target, a fresh valid target, or the explicit ON default (75°F). */
export function getStagedTargetF(monitor: DacMonitor, side: Side): number {
  const cached = states[side].target
  if (cached !== null) return cached
  const observation = freshThermostatReport(monitor)
  const target = observation?.status[side === 'left' ? 'leftSide' : 'rightSide'].targetTemperature
  return typeof target === 'number' && Number.isFinite(target) && target >= MIN_TEMP && target <= MAX_TEMP ? target : 75
}

/** Stage immediately; apply only to a recently established live session, never from an old ON latch. */
export async function setTargetTemperature(monitor: DacMonitor, side: Side, requestedF: number): Promise<void> {
  const target = clampF(requestedF), state = states[side]
  state.target = target
  await withSideLock(side, async () => {
    const evidence = powerEvidence(monitor, side)
    if (!evidence.powered) return
    assertNotGuardBlocked(side, `setTemperature(${side}, ${target})`)
    try {
      await logged(`setTemperature(${side}, ${target})`, () => getTemperatureController().setManualLocked(
        side, target, undefined, undefined, () => {
          if (!powerEvidence(monitor, side).powered) throw new HapStatusError(-70402)
        },
      ))
      // Rapid slider updates may share the original evidence window; they cannot extend it indefinitely.
      state.receipt = { ...evidence, revision: getStatusRevision() }
    }
    catch (error) {
      state.receipt = null // Failed/ambiguous writes cannot authorize a later slider gesture.
      throw error
    }
  })
}

/** Explicit ON is allowed without telemetry; its acknowledgement never becomes a reported measurement. */
export async function setSidePowerOn(monitor: DacMonitor, side: Side): Promise<void> {
  assertNotGuardBlocked(side, `setPower(${side}, true)`)
  const state = states[side], request: PowerRequest = { powered: true }
  state.pending = request
  try {
    await withSideLock(side, async () => {
      assertNotGuardBlocked(side, `setPower(${side}, true)`)
      const target = clampF(getStagedTargetF(monitor, side))
      state.target = target
      const jobManager = await getJobManager()
      jobManager.releaseHeldPowerOff(side)
      const evidenceAt = Date.now()
      await logged(`setPower(${side}, true, ${target})`, () => getTemperatureController().setManualLocked(side, target))
      state.receipt = { powered: true, evidenceAt, expiresAt: evidenceAt + THERMOSTAT_FRESH_MS, revision: getStatusRevision() }
    })
  }
  catch (error) {
    state.receipt = null
    throw error
  }
  finally { if (state.pending === request) state.pending = null }
}

/** OFF stays available with missing telemetry or a tripped guard. */
export async function setSidePowerOff(_monitor: DacMonitor, side: Side): Promise<void> {
  const state = states[side], request: PowerRequest = { powered: false }
  state.pending = request
  try {
    await withSideLock(side, async () => {
      const evidenceAt = Date.now()
      await logged(`setPower(${side}, false)`, () => getTemperatureController().powerOffLocked(side, true))
      state.receipt = { powered: false, evidenceAt, expiresAt: evidenceAt + THERMOSTAT_FRESH_MS, revision: getStatusRevision() }
    })
  }
  catch (error) {
    state.receipt = null
    throw error
  }
  finally { if (state.pending === request) state.pending = null }
}

/** Test-only reset; live state remains process-local and is never restored as evidence after restart. */
export function __resetSideController(): void {
  for (const side of ['left', 'right'] as const) {
    states[side].target = null
    states[side].pending = null
    states[side].receipt = null
  }
}
