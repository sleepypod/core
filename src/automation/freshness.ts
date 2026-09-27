/** Source freshness limits shared by live signal readers and historical replay. */
export const DEVICE_FRESH_MS = 15_000
export const VITALS_FRESH_MS = 5 * 60_000
export const MOVEMENT_FRESH_MS = 5 * 60_000
export const ENV_FRESH_MS = 15 * 60_000
export const CAP_FRESH_MS = 30_000

export function signalFreshnessMs(key: string): number {
  if (key.includes('.cap.')) return CAP_FRESH_MS
  if (key.endsWith('.movement')) return MOVEMENT_FRESH_MS
  if (/\.(heartRate|hrv|breathingRate)$/.test(key)) return VITALS_FRESH_MS
  if (key === 'water.low' || /\.(currentTemperature|targetTemperature|currentLevel)$/.test(key)) return DEVICE_FRESH_MS
  return ENV_FRESH_MS
}
