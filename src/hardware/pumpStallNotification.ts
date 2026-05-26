/**
 * In-memory pump stall notification state (per side). Set by pumpStallGuard
 * when a side trips, cleared by the user dismiss / re-enable mutations.
 *
 * Lives on globalThis for the same reason as primeNotification.ts —
 * Turbopack chunks this module separately into the API runtime and the
 * instrumentation runtime; per-chunk `let` would split the state.
 */

import type { Side } from './types'

const G = globalThis as Record<string, unknown>
const KEYS = {
  left: '__sp_pump_stall_left__',
  right: '__sp_pump_stall_right__',
} as const

export interface PumpStallNotice {
  alertId: number
  /** unix seconds */
  trippedAt: number
  rpm: number
  restore: {
    targetTemperature: number
    durationSeconds: number
  } | null
}

export function setPumpStallNotice(side: Side, notice: PumpStallNotice): void {
  G[KEYS[side]] = notice
}

export function getPumpStallNotice(side: Side): PumpStallNotice | null {
  const v = G[KEYS[side]] as PumpStallNotice | null | undefined
  return v ?? null
}

export function getAllPumpStallNotices(): {
  left: PumpStallNotice | null
  right: PumpStallNotice | null
} {
  return {
    left: getPumpStallNotice('left'),
    right: getPumpStallNotice('right'),
  }
}

export function clearPumpStallNotice(side: Side): void {
  G[KEYS[side]] = null
}

export function resetPumpStallNotifications(): void {
  G[KEYS.left] = null
  G[KEYS.right] = null
}
