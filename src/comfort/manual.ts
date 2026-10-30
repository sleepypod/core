import { sqlite } from '@/src/db'
import type { Side } from '@/src/hardware/types'
import { MANUAL_PAUSE_MS } from './policy'
import { comfortEvent, createComfortStore } from './store'

const state = globalThis as typeof globalThis & { __sp_comfortPauseFaults?: Partial<Record<Side, number>> }
const faults = state.__sp_comfortPauseFaults ??= {}

/** Caller holds the side lock. A failed journal must never prevent manual shutdown. */
export function pauseComfortAfterManual(side: Side): void {
  const now = Date.now()
  try {
    const store = createComfortStore(sqlite)
    const current = store.read(side)
    store.commit(side, { ...current, pausedUntil: Math.max(current.pausedUntil, now + MANUAL_PAUSE_MS) },
      comfortEvent(now, 'manual_pause', 'Personal comfort paused for six hours after a manual control.'), true)
    faults[side] = undefined
  }
  catch {
    // Keep the latest failed intent in memory until it is durably recorded.
    if (!faults[side]) console.warn(`[comfort] ${side} manual pause could not be persisted; personal comfort is withheld`)
    faults[side] = now
  }
}

export function pendingManualPause(side: Side): number | null {
  return faults[side] ?? null
}
export function acknowledgeManualPause(side: Side, at: number): void {
  if (faults[side] === at) faults[side] = undefined
}
