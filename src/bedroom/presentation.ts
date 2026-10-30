import type { BedroomObservation } from './contract'

/** Compare elapsed browser time with the server's remaining lease, without assuming clocks are identical. */
export function bedroomReadingCurrent(generatedAt: number, receivedAt: number, expiresAt: number | null, now: number, failed = false): boolean {
  if (failed || !Number.isSafeInteger(generatedAt) || !Number.isSafeInteger(receivedAt) || expiresAt === null) return false
  const elapsed = now - receivedAt
  return elapsed >= 0 && elapsed < 15_000 && expiresAt - generatedAt > elapsed
}

/** Historical display is separate from freshness and never contributes to an aggregate or control decision. */
export function bedroomReportedReading(observation: BedroomObservation, generatedAt: number) {
  const timestamp = observation.measuredAt ?? observation.observedAt
  if (observation.status === 'disabled' || observation.status === 'unavailable'
    || observation.lastValue === null || !Number.isFinite(observation.lastValue)
    || timestamp === null || !Number.isSafeInteger(timestamp) || timestamp <= 0
    || !Number.isSafeInteger(generatedAt) || timestamp > generatedAt) return null
  return { value: observation.lastValue, timestamp }
}

export function bedroomValueLabel(metric: BedroomObservation['source']['metric'], value: number | null, unit: string) {
  if (value === null) return '—'
  if (metric === 'power') return value === 1 ? 'On' : 'Off'
  if (metric === 'airQuality') return ['Unknown', 'Excellent', 'Good', 'Fair', 'Inferior', 'Poor'][value] ?? 'Unknown'
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}${unit === '°F' || unit === '%' ? '' : ' '}${unit}`
}

export const bedroomProviderHint = {
  apple_home: 'Waiting for an Apple Home sensor export. Discovering a HomePod alone does not deliver its temperature or humidity.',
  homebridge: 'Waiting for the Homebridge publisher. Cached reports can be displayed but cannot drive room adjustments.',
  home_assistant: 'Waiting for a sensor report from Home Assistant. Check the publisher and its source mapping.',
}
