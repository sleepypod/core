/**
 * Manages alarm snooze timeouts per side.
 * Snooze = clear alarm immediately, re-trigger after duration expires.
 *
 * Snooze map lives on globalThis: Turbopack bundles this module into both
 * the instrumentation chunk (homekit snoozeSwitch sets it) and the API
 * chunks (device router reads it), so per-chunk `const map = new Map()`
 * would silently keep them in separate Maps.
 */
import { getSharedHardwareClient } from './dacMonitor.instance'
import type { Side } from './types'

interface SnoozeState {
  timeoutId: ReturnType<typeof setTimeout>
  snoozeUntil: Date
  config: { vibrationIntensity: number, vibrationPattern: 'double' | 'rise', duration: number }
}

const G = globalThis as Record<string, unknown>
const SNOOZE_KEY = '__sp_snooze_active__'

function getActiveSnoozes(): Map<Side, SnoozeState> {
  let m = G[SNOOZE_KEY] as Map<Side, SnoozeState> | undefined
  if (!m) {
    m = new Map<Side, SnoozeState>()
    G[SNOOZE_KEY] = m
  }
  return m
}

export function snoozeAlarm(
  side: Side,
  durationSeconds: number,
  config: SnoozeState['config'],
): Date {
  // Cancel any existing snooze for this side
  cancelSnooze(side)

  // Clamp to setTimeout's 32-bit ms ceiling — a larger delay wraps and the
  // alarm restarts immediately instead of after the snooze. (The tRPC route
  // caps duration at 1800s; this guards other callers.)
  durationSeconds = Math.min(durationSeconds, Math.floor((2 ** 31 - 1) / 1000))

  const snoozeUntil = new Date(Date.now() + durationSeconds * 1000)

  const timeoutId = setTimeout(async () => {
    getActiveSnoozes().delete(side)
    try {
      const client = getSharedHardwareClient()
      await client.setAlarm(side, config)
      const { broadcastMutationStatus } = await import('@/src/streaming/broadcastMutationStatus')
      broadcastMutationStatus(side, { isAlarmVibrating: true })
    }
    catch (err) {
      console.error(`[Snooze] Failed to restart alarm for ${side}:`, err)
    }
  }, durationSeconds * 1000)

  getActiveSnoozes().set(side, { timeoutId, snoozeUntil, config })
  return snoozeUntil
}

export function cancelSnooze(side: Side): void {
  const map = getActiveSnoozes()
  const existing = map.get(side)
  if (existing) {
    clearTimeout(existing.timeoutId)
    map.delete(side)
  }
}

export function getSnoozeStatus(side: Side): { active: boolean, snoozeUntil: number | null } {
  const state = getActiveSnoozes().get(side)
  return {
    active: !!state,
    snoozeUntil: state ? Math.floor(state.snoozeUntil.getTime() / 1000) : null,
  }
}
