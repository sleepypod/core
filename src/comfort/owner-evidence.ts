import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import { temperatureApplicationSchema } from '@/src/temperature/applications'
import { DEVICE_MAX_AGE_MS, type ComfortContext, type ComfortState } from './policy'
import { PreviewReportError } from './report-summary'
import { qualificationEvidenceSchema, type OwnerIdentity, type Qualification, type QualificationKind } from './owner-contract'

const DAY_MS = 86_400_000
export function requireOwner(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PreviewReportError(message, 'PRECONDITION_FAILED')
}
function recent(value: number | null | undefined, now: number, age: number) {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value > 0 && value <= now && now - value <= age
}

/** Reads only. An acknowledgment is never translated into a claim that the owner felt the bed change. */
export function readQualificationEvidence(database: Database.Database, side: Side, identity: OwnerIdentity,
  state: ComfortState, context: ComfortContext, kind: QualificationKind | null, previous: Qualification[]) {
  const { now, device, presence } = context
  requireOwner(recent(device.observedAt, now, DEVICE_MAX_AGE_MS), 'A fresh firmware status is required.')
  requireOwner(device.waterAdequate === true && !device.priming && !device.vibrating && device.baseMoving === false,
    'Wait for adequate water and confirmed idle priming, vibration and base telemetry.')
  const calibrated = presence.available && recent(presence.entry?.measuredAt, now, 30_000)
    && recent(presence.observedAt, now, 30_000) && presence.entry?.sourceKey === identity.calibration
  const occupied = calibrated && presence.occupied && presence.entry?.state === 'present'
  const empty = calibrated && !presence.occupied && presence.entry?.state === 'absent'
  if (kind === 'presence_empty') requireOwner(empty, 'Waiting for a fresh calibrated empty-side reading.')
  if (kind === 'presence_occupied') requireOwner(occupied, 'Waiting for a fresh calibrated occupied-side reading.')
  let applicationId: string | null = null
  let applicationAt: number | null = null
  let alarmAt: number | null = null
  if (kind === 'cooling' || kind === 'warming' || kind === 'offline_routine') {
    const rows = database.prepare(`SELECT id, attempt_id AS attemptId, attempted_at AS attemptedAt, finished_at AS finishedAt,
      outcome, request FROM temperature_applications WHERE side = ? AND attempted_at >= ? ORDER BY id DESC LIMIT 100`)
      .all(side, now - DAY_MS) as { id: number, attemptId: string, attemptedAt: number, finishedAt: number | null, outcome: string, request: string }[]
    const matching = rows.map(({ request, ...row }) => temperatureApplicationSchema.parse({ ...JSON.parse(request), ...row,
      acknowledgment: row.outcome === 'acknowledged' ? 'accepted_not_physically_verified' : 'unconfirmed' }))
      .find(row => row.outcome === 'acknowledged' && recent(row.finishedAt, now, kind === 'offline_routine' ? DAY_MS : 30 * 60_000)
        && row.side === side && (kind === 'offline_routine'
        ? row.source === 'schedule'
        : row.source === 'manual' && row.targetF === device.targetF && now - (row.finishedAt ?? now) >= 60_000))
    requireOwner(matching, kind === 'offline_routine'
      ? 'No acknowledged scheduled temperature application in the last 24 hours.'
      : 'Use a manual temperature target, then wait at least a minute. Its acknowledgment must be within 30 minutes and match the fresh firmware target.')
    applicationId = matching.attemptId
    applicationAt = matching.finishedAt
    if (kind !== 'offline_routine') {
      requireOwner(device.powered && device.targetF !== null && device.targetF >= state.config.minimumF && device.targetF <= state.config.maximumF,
        'The powered side must report a target inside the reviewed comfort range.')
      const other = previous.find(value => value.kind === (kind === 'warming' ? 'cooling' : 'warming') && value.outcome === 'confirmed')
      if (other) requireOwner(other.evidence.targetF !== null && (kind === 'warming'
        ? device.targetF >= other.evidence.targetF + 2
        : device.targetF <= other.evidence.targetF - 2), 'Use distinct cooling and warming targets at least 2°F apart.')
    }
    else {
      const alarm = database.prepare(`SELECT attempted_at AS at FROM alarm_occurrences WHERE side = ? AND outcome = 'acknowledged'
        AND attempted_at >= ? AND attempted_at <= ? ORDER BY attempted_at DESC LIMIT 1`).get(side, now - DAY_MS, now) as { at: number } | undefined
      requireOwner(alarm, 'No acknowledged local wake alarm in the last 24 hours. Attend the offline wake/cancellation test first.')
      alarmAt = alarm.at
    }
  }
  if (kind === 'manual_stop') {
    requireOwner(!device.powered && device.offConfirmed === true && state.pausedUntil > now, 'Switch this side off using the normal manual control and wait for its fresh firmware report and six-hour pause.')
    requireOwner(['cooling', 'warming'].every(value => previous.some(record => record.kind === value && record.outcome === 'confirmed'
      && recent(record.at, now, DAY_MS))), 'Complete both attended temperature checks within the last 24 hours before recording Stop.')
  }
  return qualificationEvidenceSchema.parse({ identity, observedAt: device.observedAt, presenceAt: presence.entry?.measuredAt ?? null,
    presence: occupied ? 'occupied' : empty ? 'empty' : 'unavailable', powered: device.powered, offConfirmed: device.offConfirmed === true, targetF: device.targetF,
    applicationId, applicationAt, alarmAt, pausedUntil: state.pausedUntil })
}

/** Poll times may advance during review; the actual evidence references and meaningful state may not. */
export function evidenceMeaning(value: ReturnType<typeof readQualificationEvidence>) {
  return JSON.stringify({ ...value, observedAt: undefined, presenceAt: undefined })
}
