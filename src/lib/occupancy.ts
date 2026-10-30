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
 *      Live capSense / capSense2 channel readings vs the per-side calibration baseline
 *      from `calibration_profiles`, with reference-channel compensation.
 *      Mirrors the Python sleep-detector's per-sample presence check.
 *
 * Movement alone is blind to a person who is lying perfectly still; level
 * alone is blind to brief presence events that don't sustain a baseline
 * deviation. The OR closes both gaps.
 *
 * On top of `occupied`, `classification` separates a person from a light load
 * (a pet, a laptop, a folded duvet). A person spans head, torso and legs, so
 * at least two of the three capSense2 zones deviate; a pet concentrates on one.
 * Human-range vitals from the piezo processor upgrade an ambiguous load to a
 * person but never downgrade one — vitals drop out whenever the sleeper moves,
 * and a missing reading must not read as "not a person". Consumers that act on
 * presence (auto-on) fire only on `person`; consumers that act on absence
 * (auto-off) treat `light` as empty.
 */

import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import { biometricsDb } from '@/src/db/biometrics'
import { calibrationProfiles, movement, vitals } from '@/src/db/biometrics-schema'
import { getLatestCapSenseSnapshot } from '@/src/streaming/piezoStream'
import { RESTLESS_SCORE_MIN } from '@/src/lib/movement'
import type { Side } from '@/src/hardware/types'
import { evaluateCapacitance, parseCapacitanceCalibration } from './capacitanceLevel'
import { capacitanceSourceKey } from './capacitanceIdentity'

const MOVEMENT_WINDOW_MS = 15 * 60_000
/** capSense2 nominally arrives at ~2 Hz. >30s gap = sensor / stream down. */
const CAPSENSE_STALE_MS = 30_000
/** Latest vitals row older than this is treated as absent (matches the
 *  automation engine's VITALS_FRESH_MS). */
const VITALS_WINDOW_MS = 5 * 60_000
/** Resting human ranges. Outside them (or absent) is "no evidence", not "pet". */
const HUMAN_HR_MIN = 40
const HUMAN_HR_MAX = 110
const HUMAN_BR_MIN = 8
const HUMAN_BR_MAX = 22
/** Zones a load must light (of head/torso/legs) to classify as a person. */
export const PERSON_MIN_ZONES = 2

export interface MovementSignal {
  active: boolean
  peakScore: number
}

export interface LevelSignal {
  /** Firmware measurement time and calibrated source identity for transition tracking. */
  sampleAt?: number
  sourceKey?: string
  active: boolean
  /** Sum of compensated per-channel deviation from baseline, or null when
   *  the signal can't be evaluated (no frame, stale frame, no calibration). */
  deviation: number | null
  /** Calibration threshold the deviation must exceed, or null when unavailable. */
  threshold: number | null
  /** Milliseconds since the latest capSense2 frame was received, or null
   *  when no frame has ever been seen. */
  ageMs: number | null
  /** Compensated deviation per zone [head, torso, legs], or null when the
   *  level signal can't be evaluated. */
  zoneDeviations: number[] | null
  /** Zones whose deviation exceeds a third of the calibrated threshold, or
   *  null when the level signal can't be evaluated. A person lights >= 2. */
  zones: number | null
}

export interface VitalsSignal {
  heartRate: number | null
  breathingRate: number | null
  /** True when a fresh reading sits in resting human range, false when a fresh
   *  reading is outside it, null when there is no fresh reading. */
  humanRange: boolean | null
}

/**
 *   'person' — occupied and the load looks like a person (>= PERSON_MIN_ZONES
 *              zones, or human-range vitals, or movement with no level signal
 *              to say otherwise)
 *   'light'  — occupied, level signal evaluable, but the load sits on a single
 *              zone with no human vitals (pet, object)
 *   'none'   — not occupied
 */
export type OccupancyClassification = 'person' | 'light' | 'none'

export interface OccupancyResult {
  occupied: boolean
  movement: MovementSignal
  level: LevelSignal
  vitals: VitalsSignal
  classification: OccupancyClassification
  /**
   * True when presence can be sensed reliably enough to act on its ABSENCE —
   * i.e. the level signal is evaluable (fresh capacitance frame + completed
   * calibration). Only the level signal detects a perfectly still occupant;
   * movement alone reads a motionless sleeper as empty. Consumers that power
   * hardware off on "empty" (autoOffWatcher) must check this first and stand
   * down when false, so missing/uncalibrated biometrics never trigger an
   * action.
   */
  available: boolean
}

export function getOccupancy(side: Side): OccupancyResult {
  const movementSignal = readMovementSignal(side)
  const levelSignal = readLevelSignal(side)
  const vitalsSignal = readVitalsSignal(side)
  const occupied = movementSignal.active || levelSignal.active
  return {
    occupied,
    movement: movementSignal,
    level: levelSignal,
    vitals: vitalsSignal,
    classification: classify(occupied, levelSignal, vitalsSignal),
    available: levelSignal.deviation !== null,
  }
}

/** See `OccupancyClassification`. Vitals only ever upgrade to `person`. */
export function classify(occupied: boolean, level: LevelSignal, vitalsSignal: VitalsSignal): OccupancyClassification {
  if (!occupied) return 'none'
  if (vitalsSignal.humanRange === true) return 'person'
  if (level.zones !== null) return level.zones >= PERSON_MIN_ZONES ? 'person' : 'light'
  return 'person'
}

function readVitalsSignal(side: Side): VitalsSignal {
  const absent: VitalsSignal = { heartRate: null, breathingRate: null, humanRange: null }
  try {
    const [row] = biometricsDb
      .select({ id: vitals.id, timestamp: vitals.timestamp, heartRate: vitals.heartRate, breathingRate: vitals.breathingRate })
      .from(vitals)
      .where(eq(vitals.side, side))
      .orderBy(desc(vitals.timestamp))
      .limit(1)
      .all()
    if (!row || !isMechanicallyQualifiedVital(biometricsDb.$client, row.id, Date.now())) return absent
    const ts = row.timestamp instanceof Date ? row.timestamp.getTime() : Number(row.timestamp) * 1000
    if (!Number.isFinite(ts) || ts > Date.now() || Date.now() - ts > VITALS_WINDOW_MS) return absent
    const heartRate = Number.isFinite(row.heartRate) ? row.heartRate : null
    const breathingRate = Number.isFinite(row.breathingRate) ? row.breathingRate : null
    if (heartRate === null && breathingRate === null) return absent
    const hrHuman = heartRate === null ? true : heartRate >= HUMAN_HR_MIN && heartRate <= HUMAN_HR_MAX
    const brHuman = breathingRate === null ? true : breathingRate >= HUMAN_BR_MIN && breathingRate <= HUMAN_BR_MAX
    return { heartRate, breathingRate, humanRange: hrHuman && brHuman }
  }
  catch {
    return absent
  }
}

function readMovementSignal(side: Side): MovementSignal {
  try {
    const since = new Date(Date.now() - MOVEMENT_WINDOW_MS)
    const [row] = biometricsDb
      .select({ peak: sql<number>`MAX(${movement.totalMovement})` })
      .from(movement)
      .where(and(eq(movement.side, side), gte(movement.timestamp, since), lte(movement.timestamp, new Date())))
      .limit(1)
      .all()
    const peak = typeof row?.peak === 'number' && Number.isFinite(row.peak) ? row.peak : 0
    return { active: peak >= RESTLESS_SCORE_MIN, peakScore: peak }
  }
  catch {
    return { active: false, peakScore: 0 }
  }
}

function readLevelSignal(side: Side): LevelSignal {
  const snapshot = getLatestCapSenseSnapshot()
  const empty: LevelSignal = { active: false, deviation: null, threshold: null, ageMs: null, zoneDeviations: null, zones: null }
  if (!snapshot) return empty
  const now = Date.now()
  const ageMs = now - snapshot.receivedAtMs
  const sampleAgeMs = now - snapshot.ts * 1000
  if (!Number.isFinite(ageMs) || !Number.isFinite(sampleAgeMs)
    || ageMs < 0 || sampleAgeMs < 0 || ageMs > CAPSENSE_STALE_MS || sampleAgeMs > CAPSENSE_STALE_MS) {
    return { ...empty, ageMs: Number.isFinite(ageMs) ? ageMs : null }
  }
  // Scalar firmware lacks the independent channels needed by either calibration.
  const values = snapshot[side]
  if (!Array.isArray(values)) return { ...empty, ageMs }
  const profile = readCapSenseCalibration(side, snapshot.type)
  if (!profile) return { ...empty, ageMs }
  const { calibration, sourceKey } = profile
  const result = evaluateCapacitance(values, calibration, snapshot[`${side}Status`])
  return { ...result, ageMs, ...(result.deviation === null
    ? {}
    : {
        sampleAt: snapshot.ts * 1000,
        ...(sourceKey === null ? {} : { sourceKey }),
      }) }
}

function readCapSenseCalibration(side: Side, format: 'capSense' | 'capSense2') {
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
    const calibration = parseCapacitanceCalibration(row.parameters, format)
    return calibration ? { calibration, sourceKey: capacitanceSourceKey(side, row.parameters, calibration) } : null
  }
  catch {
    return null
  }
}
import { isMechanicallyQualifiedVital } from '@/src/biometrics/mechanical/eligibility'
