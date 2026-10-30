import type { LevelSignal } from './occupancy'

type CapacitanceFormat = 'capSense' | 'capSense2'
export interface CapacitanceCalibration {
  format: CapacitanceFormat
  means: number[]
  threshold: number
  referenceMean: number
}

const LEGACY_RAW_THRESHOLD = 300 // Must match modules/common/calibration.py.
const REFERENCE_NOMINAL = 1.16
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** Match Python's raw-unit calibration; old untagged z-score thresholds are not interchangeable. */
export function parseCapacitanceCalibration(value: unknown, format: CapacitanceFormat): CapacitanceCalibration | null {
  const profile = asRecord(value)
  if (profile.format !== format && !(format === 'capSense' && profile.format === undefined)) return null
  const names = format === 'capSense' ? ['out', 'cen', 'in'] : ['A', 'B', 'C']
  const channels = asRecord(profile.channels)
  const means = names.map(name => asRecord(channels[name]).mean)
  if (!means.every(isFiniteNumber)) return null
  const threshold = format === 'capSense'
    ? profile.format === undefined ? LEGACY_RAW_THRESHOLD : profile.threshold ?? LEGACY_RAW_THRESHOLD
    : profile.threshold
  const referenceMean = asRecord(profile.ref).mean ?? REFERENCE_NOMINAL
  if (!isFiniteNumber(threshold) || threshold <= 0 || !isFiniteNumber(referenceMean)) return null
  return { format, means, threshold, referenceMean }
}

/** Evaluate a complete live frame without inventing anatomy for legacy out/centre/in electrodes. */
export function evaluateCapacitance(values: number[], calibration: CapacitanceCalibration, status?: string | null): Omit<LevelSignal, 'ageMs'> {
  const empty = { active: false, deviation: null, threshold: calibration.threshold, zoneDeviations: null, zones: null }
  if (status != null && status !== 'good') return empty
  const legacy = calibration.format === 'capSense'
  const validLength = legacy ? values.length === 6 : values.length === 6 || values.length === 8
  if (!validLength || !values.every(isFiniteNumber) || values.some(value => value < 0)) return empty
  // Legacy channels are duplicated during normalization, not independent electrode pairs.
  if (legacy && [0, 2, 4].some(index => values[index] !== values[index + 1])) return empty
  const referenceDelta = !legacy && values.length === 8
    ? (values[6] + values[7]) / 2 - calibration.referenceMean
    : 0
  const deviations = [0, 2, 4].map((index, channel) =>
    (values[index] + values[index + 1]) / 2 - referenceDelta - calibration.means[channel])
  const deviation = deviations.reduce((total, value) => total + value, 0)
  if (!Number.isFinite(deviation)) return empty
  return {
    active: deviation > calibration.threshold,
    deviation,
    threshold: calibration.threshold,
    zoneDeviations: legacy ? null : deviations,
    zones: legacy ? null : deviations.filter(value => value > calibration.threshold / 3).length,
  }
}
