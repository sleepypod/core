import { biometricsDb } from '@/src/db'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { getPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import { getOccupancy } from '@/src/lib/occupancy'
import { getLatestCapSenseSnapshot } from '@/src/streaming/piezoStream'
import type { Side } from '@/src/hardware/types'
import { homeSensors } from './sensorCache'
import { readHomeVitals } from './vitals'
import { finite, sample, type TelemetrySample } from './sample'
import { legacyPrivacyState } from '@/src/household/legacyPrivacy'

function privateSample(fields: string[]): TelemetrySample {
  return { schemaVersion: 1, ts: null, expiresAt: null, source: 'personal_privacy_boundary', available: false, reason: 'privacy_required',
    ...Object.fromEntries(fields.map(field => [field, null])) }
}

export function readHomeOccupancy(side: Side, now = Date.now()): TelemetrySample {
  if (legacyPrivacyState() !== 'legacy') return privateSample(['occupied', 'classification'])
  try {
    const occupancy = getOccupancy(side)
    const frame = getLatestCapSenseSnapshot()
    return sample('calibrated_capacitance_and_movement', frame ? frame.ts * 1000 : null, 30_000, now,
      { occupied: occupancy.occupied, classification: occupancy.classification },
      occupancy.available && !!frame && frame.receivedAtMs <= now && now - frame.receivedAtMs < 30_000)
  }
  catch { return sample('calibrated_capacitance_and_movement', null, 30_000, now, { occupied: null, classification: null }) }
}

/** Read existing sources only; this must never initialize or control hardware. */
export function readHomeTelemetry(now = Date.now()): Record<string, TelemetrySample> {
  const personal = legacyPrivacyState() !== 'legacy'
  const monitor = getDacMonitorIfRunning()
  const status = monitor?.getFreshStatus(15_000)
  const deviceAt = monitor?.getLastPollAt() ?? null
  const device = (values: Record<string, unknown>) => sample('reported_dac_status', deviceAt, 15_000, now, values, !!status)
  const readings: Record<string, TelemetrySample> = {
    'state/device-status': device({ leftSide: status?.leftSide, rightSide: status?.rightSide,
      waterLevel: status?.waterLevel, isPriming: status?.isPriming, podVersion: status?.podVersion }),
    'state/water-level': device({ level: status?.waterLevel }),
    'state/environment/ambient': homeSensors.ambient(now),
  }
  for (const side of ['left', 'right'] as const) {
    const reported = status?.[side === 'left' ? 'leftSide' : 'rightSide']
    const powered = reported ? reported.targetLevel !== 0 : null
    readings[`state/${side}/climate`] = device({ currentTemperature: finite(reported?.currentTemperature),
      targetTemperature: finite(reported?.targetTemperature), isPowered: powered,
      mode: powered === null ? null : powered ? 'heat' : 'off', stateKind: 'reported' })
    const occupancy = readHomeOccupancy(side, now)
    const vitals = personal ? privateSample(['heartRate', 'breathingRate', 'hrv']) : readHomeVitals(biometricsDb.$client, side, now)
    // Fresh signal estimates alone are not evidence that a person is in bed.
    const occupied = occupancy.available && occupancy.occupied === true && occupancy.classification === 'person'
    readings[`state/biometrics/${side}`] = personal
      ? vitals
      : occupied
        ? {
            ...vitals,
            expiresAt: vitals.expiresAt !== null && occupancy.expiresAt !== null
              ? Math.min(vitals.expiresAt, occupancy.expiresAt)
              : vitals.expiresAt,
          }
        : { ...vitals, available: false, reason: 'unqualified', heartRate: null, breathingRate: null, hrv: null }
    readings[`state/occupancy/${side}`] = occupancy
    const pump = homeSensors.pump(side, now)
    readings[`pump/${side}/rpm`] = { ...pump, temperature: undefined }
    readings[`pump/${side}/loop_temp_c`] = { ...pump, rpm: undefined }
    // This is the current software warning, not a physical pump-health diagnosis.
    readings[`pump/${side}/stall`] = sample('software_stall_notice', now, 15_000, now,
      { active: !!getPumpStallNotice(side) })
  }
  return readings
}
