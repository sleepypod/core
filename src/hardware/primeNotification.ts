/**
 * In-memory prime completion notification state.
 * Set when DacMonitor detects isPriming transition from true → false.
 * Cleared when iOS client dismisses via API.
 */

let primeCompletedAt: Date | null = null
let wasPriming = false

export function trackPrimingState(isPriming: boolean): void {
  if (!wasPriming && isPriming) {
    // New priming cycle — clear stale notification
    primeCompletedAt = null
  }
  else if (wasPriming && !isPriming) {
    primeCompletedAt = new Date()
  }
  wasPriming = isPriming
}

export function getPrimeCompletedAt(): number | null {
  return primeCompletedAt ? Math.floor(primeCompletedAt.getTime() / 1000) : null
}

export function dismissPrimeNotification(): void {
  primeCompletedAt = null
}
