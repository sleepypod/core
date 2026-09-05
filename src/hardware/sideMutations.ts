/**
 * Per-side mutation stamps shared by API writers and the DAC-poll mirror.
 * Turbopack can load them in different module instances, so keep the stamps
 * on globalThis. A new command invalidates evidence from the old session.
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

export function markSideMutated(side: Side): void {
  stamps()[side] = Date.now()
}

export function getLastSideMutationAt(side: Side): number {
  return stamps()[side]
}

/** @internal — for tests only */
export function _resetMutationStamps(): void {
  stamps().left = 0
  stamps().right = 0
}
