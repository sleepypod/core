/**
 * Virtual occupancy sensor — single source of truth shared by the HomeKit
 * OccupancySensor accessory and the web-app PresenceCard.
 *
 * Combines two signals via OR:
 *
 *   1. Movement signal (catches an active occupant).
 *      `MAX(movement.total_movement)` over the last MOVEMENT_WINDOW_MS,
 *      compared to RESTLESS_SCORE_MIN. Identical to the original HomeKit logic.
 *
 *   2. Level signal (catches a still occupant — deep sleep, etc.).
 *      Live capSense / capSense2 channel readings vs the matching per-side
 *      calibration baseline from `calibration_profiles`. Named-channel
 *      capSense uses calibrated z-scores; capSense2 keeps its compensated
 *      channel-delta evaluator.
 *
 * Movement alone is blind to a person who is lying perfectly still; level
 * alone is blind to brief presence events that don't sustain a baseline
 * deviation. The OR closes both gaps.
 */

import { and, eq, gte, sql } from 'drizzle-orm'
import { biometricsDb } from '@/src/db/biometrics'
import { calibrationProfiles, movement } from '@/src/db/biometrics-schema'
import { getLatestCapSenseSnapshot } from '@/src/streaming/piezoStream'
import { RESTLESS_SCORE_MIN } from '@/src/lib/movement'
import type { Side } from '@/src/hardware/types'

const MOVEMENT_WINDOW_MS = 15 * 60_000
/** Capacitance frames nominally arrive at ~2 Hz. >30s gap = sensor / stream down. */
const CAPSENSE_STALE_MS = 30_000
/** Nominal reference-channel value used when the calibration profile is
 *  missing a `ref.mean` field (older profiles). Matches the documented
 *  capSense2 reference baseline. */
const REF_NOMINAL = 1.16

export interface MovementSignal {
  active: boolean
  peakScore: number
}

export interface LevelSignal {
  active: boolean
  /** Format-specific calibrated level score (named-channel z-score sum or
   *  capSense2 compensated delta), or null when the signal can't be evaluated. */
  deviation: number | null
  /** Calibration threshold the deviation must exceed, or null when unavailable. */
  threshold: number | null
  /** Milliseconds since the latest capacitance frame was received, or null
   *  when no frame has ever been seen. */
  ageMs: number | null
}

export interface OccupancyResult {
  occupied: boolean
  movement: MovementSignal
  level: LevelSignal
  /**
   * True when presence can be sensed reliably enough to act on its ABSENCE —
   * i.e. the level signal is evaluable (fresh capacitance frame + matching
   * calibration). Only the level signal detects a perfectly still occupant;
   * movement alone reads a motionless sleeper as empty. Consumers that power
   * hardware off on "empty" (autoOffWatcher) must check this first and stand
   * down when false, so missing/uncalibrated biometrics never trigger an
   * action.
   */
  available: boolean
}

interface CapSense2Calibration {
  channels: { A: { mean: number }, B: { mean: number }, C: { mean: number } }
  threshold: number
  format: string
  ref?: { mean: number }
}

interface CapSenseChannelBaseline {
  mean: number
  std: number
}

interface CapSenseCalibration {
  channels: {
    out: CapSenseChannelBaseline
    cen: CapSenseChannelBaseline
    in: CapSenseChannelBaseline
  }
  threshold: number
  /** Older named-channel profiles omit format; absence means capSense. */
  format?: 'capSense'
}

export function getOccupancy(side: Side): OccupancyResult {
  const movementSignal = readMovementSignal(side)
  const levelSignal = readLevelSignal(side)
  return {
    occupied: movementSignal.active || levelSignal.active,
    movement: movementSignal,
    level: levelSignal,
    available: levelSignal.deviation !== null,
  }
}

function readMovementSignal(side: Side): MovementSignal {
  try {
    const since = new Date(Date.now() - MOVEMENT_WINDOW_MS)
    const [row] = biometricsDb
      .select({ peak: sql<number>`MAX(${movement.totalMovement})` })
      .from(movement)
      .where(and(eq(movement.side, side), gte(movement.timestamp, since)))
      .limit(1)
      .all()
    const peak = row?.peak ?? 0
    return { active: peak >= RESTLESS_SCORE_MIN, peakScore: peak }
  }
  catch {
    return { active: false, peakScore: 0 }
  }
}

function readLevelSignal(side: Side): LevelSignal {
  const snap = getLatestCapSenseSnapshot()
  if (!snap) {
    return { active: false, deviation: null, threshold: null, ageMs: null }
  }

  const ageMs = Date.now() - snap.receivedAtMs
  if (ageMs > CAPSENSE_STALE_MS) {
    return { active: false, deviation: null, threshold: null, ageMs }
  }

  const values = side === 'left' ? snap.left : snap.right

  if (snap.type === 'capSense') {
    // Scalar Pod 3 frames remain fail-safe unavailable. New-firmware NATS
    // capSense sides are projected to [out,out,cen,cen,in,in] by piezoStream.
    if (!Array.isArray(values) || values.length < 6) {
      return { active: false, deviation: null, threshold: null, ageMs }
    }

    const cal = readCapSenseCalibration(side)
    if (!cal) {
      return { active: false, deviation: null, threshold: null, ageMs }
    }

    const channels = [
      (values[0] + values[1]) / 2,
      (values[2] + values[3]) / 2,
      (values[4] + values[5]) / 2,
    ]
    if (!channels.every(Number.isFinite)) {
      return { active: false, deviation: null, threshold: cal.threshold, ageMs }
    }

    const deviation = Math.abs((channels[0] - cal.channels.out.mean) / cal.channels.out.std)
      + Math.abs((channels[1] - cal.channels.cen.mean) / cal.channels.cen.std)
      + Math.abs((channels[2] - cal.channels.in.mean) / cal.channels.in.std)

    return {
      active: deviation > cal.threshold,
      deviation,
      threshold: cal.threshold,
      ageMs,
    }
  }

  const cal = readCapSense2Calibration(side)
  if (!cal) {
    return { active: false, deviation: null, threshold: null, ageMs }
  }

  if (!Array.isArray(values) || values.length < 6) {
    return { active: false, deviation: null, threshold: cal.threshold, ageMs }
  }

  const avgPair = (x: number, y: number): number => (x + y) / 2
  const a = avgPair(values[0], values[1])
  const b = avgPair(values[2], values[3])
  const c = avgPair(values[4], values[5])

  let refDelta = 0
  if (values.length >= 8) {
    const ref = avgPair(values[6], values[7])
    const refNominal = cal.ref?.mean ?? REF_NOMINAL
    refDelta = ref - refNominal
  }

  const deviation = (a - refDelta - cal.channels.A.mean)
    + (b - refDelta - cal.channels.B.mean)
    + (c - refDelta - cal.channels.C.mean)

  return {
    active: deviation > cal.threshold,
    deviation,
    threshold: cal.threshold,
    ageMs,
  }
}

function readCalibrationParameters(side: Side): unknown | null {
  try {
    const [row] = biometricsDb
      .select({ parameters: calibrationProfiles.parameters })
      .from(calibrationProfiles)
      .where(and(
        eq(calibrationProfiles.side, side),
        eq(calibrationProfiles.sensorType, 'capacitance'),
        eq(calibrationProfiles.status, 'completed'),
      ))
      .limit(1)
      .all()
    return row?.parameters ?? null
  }
  catch {
    return null
  }
}

function readCapSense2Calibration(side: Side): CapSense2Calibration | null {
  const parsed = readCalibrationParameters(side) as CapSense2Calibration | null
  if (parsed?.format !== 'capSense2') return null
  if (typeof parsed.channels?.A?.mean !== 'number'
    || typeof parsed.channels?.B?.mean !== 'number'
    || typeof parsed.channels?.C?.mean !== 'number') {
    return null
  }
  if (typeof parsed.threshold !== 'number') return null
  return parsed
}

function readCapSenseCalibration(side: Side): CapSenseCalibration | null {
  const parsed = readCalibrationParameters(side) as CapSenseCalibration | null
  if (!parsed || (parsed.format !== undefined && parsed.format !== 'capSense')) return null

  const channels = [parsed.channels?.out, parsed.channels?.cen, parsed.channels?.in]
  if (!channels.every(channel => Number.isFinite(channel?.mean)
    && Number.isFinite(channel?.std)
    && (channel?.std ?? 0) > 0)) {
    return null
  }
  if (!Number.isFinite(parsed.threshold)) return null
  return parsed
}
