export interface PumpStallRestore {
  targetTemperature: number
  durationSeconds: number
}

/**
 * Project a trip-time restore snapshot to `now` without extending the
 * session's original end. A future/skewed trip timestamp consumes no time;
 * an expired snapshot has nothing left to restore.
 */
export function remainingPumpStallRestore(
  restore: PumpStallRestore | null,
  trippedAt: number | null,
  now = Date.now(),
): PumpStallRestore | null {
  if (!restore) return null

  const elapsedMs = trippedAt == null ? 0 : Math.max(0, now - trippedAt)
  const durationSeconds = Math.floor(restore.durationSeconds - elapsedMs / 1000)
  if (durationSeconds <= 0) return null

  return {
    targetTemperature: restore.targetTemperature,
    durationSeconds,
  }
}
