/**
 * Per-side mutation stamps, shared between the DAC-poll mirror
 * (deviceStateSync freshness window) and the pump stall guard (auto-recover
 * supersede check). Kept on globalThis because writers (API routes,
 * scheduler, autoOffWatcher) and readers (DAC monitor runtime) can load
 * separate module instances under Turbopack chunking.
 */

import type { Side } from './types'

const G = globalThis as Record<string, unknown>
const KEY = '__sp_side_mutation_stamps__'

function stamps(): Record<Side, number> {
  let s = G[KEY] as Record<Side, number> | undefined
  if (!s) {
    s = { left: 0, right: 0 }
    G[KEY] = s
  }
  return s
}

/** Mark a side as just-mutated (ms epoch now). */
export function markSideMutated(side: Side): void {
  stamps()[side] = Date.now()
}

/** ms epoch of the side's last mutation stamp; 0 when never stamped. */
export function getLastSideMutationAt(side: Side): number {
  return stamps()[side]
}

/** @internal — for tests only */
export function _resetMutationStamps(): void {
  stamps().left = 0
  stamps().right = 0
}

// Whether DeviceStateSync has mirrored at least one firmware status since
// process start. The passive temperature reconcile loop waits for this: a
// device_state row left over from before a restart (crash between the
// hardware write and the DB write, a row from an older build, a session the
// firmware ended while the service was down) is not evidence of a live
// session, and reconciling from it energized sides on Pod 88 (PR #752).
// Same globalThis reasoning as the stamps above.
const SYNC_KEY = '__sp_firmware_synced__'

export function markFirmwareSynced(): void {
  G[SYNC_KEY] = true
}

export function hasFirmwareSynced(): boolean {
  return G[SYNC_KEY] === true
}

/** @internal — for tests only */
export function _resetFirmwareSynced(): void {
  G[SYNC_KEY] = false
}

// Startup evidence is process-local, never restored from device_state. Frame
// consumers snapshot it at receipt so queued frames cannot arm retroactively.
// No wall-clock comparison: NTP corrections must not revoke valid evidence.
const PUMP_RUN_KEY = '__sp_pump_run_confirmed__'

/** Confirm live heating-run evidence for this side for the current process. */
export function confirmPumpRun(side: Side): void {
  const evidence = G[PUMP_RUN_KEY] as Partial<Record<Side, boolean>> | undefined
  const next = evidence ?? {}
  next[side] = true
  G[PUMP_RUN_KEY] = next
}

/** Snapshot confirmation at frame receipt, before any asynchronous queuing. */
export function hasConfirmedPumpRun(side: Side): boolean {
  return (G[PUMP_RUN_KEY] as Partial<Record<Side, boolean>> | undefined)?.[side] === true
}

/** @internal — for tests only */
export function _resetPumpRunEvidence(): void {
  G[PUMP_RUN_KEY] = undefined
}
