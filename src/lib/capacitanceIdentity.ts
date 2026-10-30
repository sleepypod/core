import { createHash } from 'node:crypto'
import type { Side } from '@/src/hardware/types'
import type { CapacitanceCalibration } from './capacitanceLevel'

const DRIFT_FRACTION = 0.25 // Must match modules/common/calibration_identity.py.
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Identity follows an anchored calibration epoch, not each 15-minute drift publication. */
export function capacitanceSourceKey(side: Side, parameters: unknown, calibration: CapacitanceCalibration): string | null {
  const profile = record(parameters)
  if (!profile || !Object.hasOwn(profile, 'qualification_epoch')) {
    // Older producers retain strict parameter matching until they publish an epoch.
    return digest([side, calibration.format, calibration])
  }
  const epoch = record(profile.qualification_epoch)
  if (profile.source !== 'adaptive' || !epoch || epoch.version !== 1
    || typeof epoch.id !== 'string' || !/^[a-f0-9]{32}$/.test(epoch.id)
    || epoch.format !== calibration.format || epoch.threshold !== calibration.threshold
    || epoch.referenceMean !== calibration.referenceMean
    || !Array.isArray(epoch.means) || epoch.means.length !== 3 || !epoch.means.every(finite)) return null
  const anchors = epoch.means as number[]
  const drift = calibration.means.reduce((total, value, index) => total + Math.abs(value - anchors[index]), 0)
  if (drift > calibration.threshold * DRIFT_FRACTION) return null
  // Bind policy/anchor fields as well as the random ID. Reusing an ID with changed
  // thresholds, reference compensation or anchors cannot retain qualification.
  return digest([side, 'adaptive-capacitance-v1', epoch.id, epoch.format, epoch.means, epoch.threshold, epoch.referenceMean])
}
