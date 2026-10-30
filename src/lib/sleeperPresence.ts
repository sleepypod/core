import { createHash } from 'node:crypto'
import type { Side } from '@/src/hardware/types'
import type { OccupancyResult } from './occupancy'
import { activeSleeperSides, type BedState } from './singleSleeper'

interface PresenceEntry {
  measuredAt: number
  sourceKey: string
  state: 'present' | 'absent' | 'unknown'
}
export interface SleeperPresence {
  observedAt: number | null
  available: boolean
  occupied: boolean
  entry?: PresenceEntry
}

const MAX_FRAME_AGE_MS = 30_000
function timestamp(value: number | undefined, now: number) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= now && now - value <= MAX_FRAME_AGE_MS ? value : null
}

/** Logical sleeper presence is separate from the physical-zone diagnostics.
 * In solo mode either zone can establish presence; both must establish absence. */
export function readSleeperPresence(side: Side, configuration: BedState, now: number, readZone: (side: Side) => OccupancyResult): SleeperPresence {
  const active = activeSleeperSides(configuration)
  if (active.length === 0) return { observedAt: null, available: false, occupied: false }
  const solo = active.length === 1
  const sourceSides: Side[] = solo ? ['left', 'right'] : [side]
  const readings = sourceSides.map(source => readZone(source))
  const observed = readings.map(reading => reading.level.ageMs === null ? null : timestamp(now - reading.level.ageMs, now))
  const sensed = readings.every((reading, index) => reading.available && observed[index] !== null)
  const occupied = readings.some(reading => reading.classification === 'person')
  const observedAt = observed.every(value => value !== null) ? Math.min(...observed as number[]) : null
  const measured = readings.map(reading => timestamp(reading.level.sampleAt, now))
  const sourceKeys = readings.map(reading => reading.level.sourceKey)
  const provenance = measured.every(value => value !== null) && sourceKeys.every(value => value && /^[a-f0-9]{64}$/.test(value))
  // Both zones arrive in one capacitance frame. Do not fuse different frames
  // or incomplete source identities into a new absence/entry observation.
  const available = sensed && (!solo || (provenance && new Set(measured).size === 1))
  if (!available || !provenance)
    return { observedAt, available, occupied }
  const sourceKey = solo
    ? createHash('sha256').update(JSON.stringify({ version: 1, mode: 'solo-anywhere', logicalSide: active[0], sourceSides, sourceKeys })).digest('hex')
    : sourceKeys[0] as string
  // Residual movement can hold occupied=true, but cannot fabricate a fresh
  // entry event once the calibrated capacitance level is no longer present.
  const present = readings.some(reading => reading.level.active && reading.classification === 'person')
  const absent = readings.every(reading => !reading.level.active && reading.classification === 'none')
  return { observedAt, available, occupied,
    entry: { measuredAt: Math.min(...measured as number[]), sourceKey, state: present ? 'present' : absent ? 'absent' : 'unknown' } }
}
