/**
 * In-memory prime completion notification state.
 * Set when DacMonitor detects isPriming transition from true → false.
 * Cleared when iOS client dismisses via API.
 *
 * State lives on globalThis: this module is bundled into multiple chunks
 * (instrumentation runtime + every API route runtime) by Turbopack, so
 * per-chunk `let` would let the DAC monitor write to one copy while the
 * homekit prime switch / device router read from another.
 */

const G = globalThis as Record<string, unknown>
const KEYS = {
  completedAt: '__sp_prime_completedAt__',
  wasPriming: '__sp_prime_wasPriming__',
} as const

export function trackPrimingState(isPriming: boolean): void {
  const wasPriming = Boolean(G[KEYS.wasPriming])
  if (!wasPriming && isPriming) {
    // New priming cycle — clear stale notification
    G[KEYS.completedAt] = null
  }
  else if (wasPriming && !isPriming) {
    G[KEYS.completedAt] = new Date()
  }
  G[KEYS.wasPriming] = isPriming
}

export function getPrimeCompletedAt(): number | null {
  const d = G[KEYS.completedAt] as Date | null | undefined
  return d ? Math.floor(d.getTime() / 1000) : null
}

export function dismissPrimeNotification(): void {
  G[KEYS.completedAt] = null
}

export function resetPrimingState(): void {
  G[KEYS.completedAt] = null
  G[KEYS.wasPriming] = false
}
