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
 *      Live capSense2 channel readings vs the per-side calibration baseline
 *      from `calibration_profiles`, with reference-channel compensation.
 *      Mirrors the Python sleep-detector's per-sample presence check.
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
/** capSense2 nominally arrives at ~2 Hz. >30s gap = sensor / stream down. */
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
  /** Sum of compensated per-channel deviation from baseline, or null when
   *  the signal can't be evaluated (no frame, stale frame, no calibration). */
  deviation: number | null
  /** Calibration threshold the deviation must exceed, or null when unavailable. */
  threshold: number | null
  /** Milliseconds since the latest capSense2 frame was received, or null
   *  when no frame has ever been seen. */
  ageMs: number | null
}

export interface OccupancyResult {
  occupied: boolean
  movement: MovementSignal
  level: LevelSignal
}

interface CapSenseCalibration {
  channels: { A: { mean: number }, B: { mean: number }, C: { mean: number } }
  threshold: number
  format: string
  ref?: { mean: number }
}

export function getOccupancy(side: Side): OccupancyResult {
  const movementSignal = readMovementSignal(side)
  const levelSignal = readLevelSignal(side)
  return {
    occupied: movementSignal.active || levelSignal.active,
    movement: movementSignal,
    level: levelSignal,
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

  // Pod-3 legacy capSense uses a scalar-per-side and a different calibration
  // shape; level scoring there is not implemented (movement signal still works).
  if (snap.type !== 'capSense2') {
    return { active: false, deviation: null, threshold: null, ageMs }
  }

  const cal = readCapSenseCalibration(side)
  if (!cal) {
    return { active: false, deviation: null, threshold: null, ageMs }
  }

  const values = side === 'left' ? snap.left : snap.right
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

function readCapSenseCalibration(side: Side): CapSenseCalibration | null {
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
    if (!row) return null
    const parsed = row.parameters as CapSenseCalibration
    if (parsed?.format !== 'capSense2') return null
    if (typeof parsed.channels?.A?.mean !== 'number'
      || typeof parsed.channels?.B?.mean !== 'number'
      || typeof parsed.channels?.C?.mean !== 'number') {
      return null
    }
    if (typeof parsed.threshold !== 'number') return null
    return parsed
  }
  catch {
    return null
  }
}
