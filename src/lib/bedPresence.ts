/**
 * Instant bed presence from the live capacitance stream, for the MQTT bridge.
 *
 * Each ~2 Hz capSense / capSense2 frame is compared with the sleep-detector's
 * empty-bed baseline (read from its state file, where it keeps a
 * self-adjusting baseline per side). The load is the summed signed rise of the
 * side's channels over that baseline, as the detector computes it. Presence
 * enters above the baseline's threshold and leaves below half of it
 * (hysteresis), so a reading hovering at the line can't flap.
 *
 * Unlike the detector's committed presence (which waits 30 s before a change
 * counts), the state here follows the sensor at once. An optional hold delays
 * a change until it has lasted that long; a reversal within the hold cancels it.
 */

import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Side } from '@/src/hardware/types'

const STATE_VERSION = 1
/** The detector rewrites its state file at least once a minute; an older file
 *  means it has stopped and its baseline can't be trusted. */
export const BASELINE_STALE_MS = 300_000
/** Presence leaves below this fraction of the threshold by default (the
 *  detector's PRESENCE_EXIT_FRACTION). */
export const EXIT_FRACTION = 0.5
/**
 * The exit line can be set from 25% to 90% of the threshold. A just-vacated
 * mattress reads well above its empty level for a minute or more (warmth,
 * compressed foam), so a low line can report an exit long after it happened;
 * a high one reports it sooner but risks reading a sleeper whose load dips as
 * out. Below 100% so some hysteresis always remains.
 */
export const MIN_EXIT_PERCENT = 25
export const MAX_EXIT_PERCENT = 90
/** Nominal capSense2 reference level, when the baseline has none. */
const CAPSENSE2_REF_NOMINAL = 1.16
const CAPSENSE2_SENTINEL = -1
export const MAX_PRESENCE_HOLD_SECONDS = 600

export interface PresenceBaseline {
  format: 'capSense' | 'capSense2'
  /** Empty-bed level per channel: out/cen/in (capSense) or A/B/C (capSense2). */
  means: Record<string, number>
  threshold: number
  refMean: number | null
}

export function sleepDetectorStatePath(): string {
  if (process.env.SLEEP_DETECTOR_STATE_PATH) return process.env.SLEEP_DETECTOR_STATE_PATH
  const biometricsDb = process.env.BIOMETRICS_DATABASE_URL?.replace(/^file:/, '')
  const dir = biometricsDb && biometricsDb !== ':memory:' ? path.dirname(biometricsDb) : '.'
  return path.join(dir, 'sleep-detector-state.json')
}

/** Each side's empty-bed baseline, or null when it can't be read or is stale. */
export async function readPresenceBaselines(file = sleepDetectorStatePath(), now = Date.now()): Promise<Record<Side, PresenceBaseline | null>> {
  const none = { left: null, right: null }
  let state: unknown
  try {
    const { mtimeMs } = await stat(file)
    if (now - mtimeMs > BASELINE_STALE_MS) return none
    state = JSON.parse(await readFile(file, 'utf8'))
  }
  catch {
    return none
  }
  if (!state || typeof state !== 'object' || (state as { version?: unknown }).version !== STATE_VERSION) return none
  const sides = state as Record<string, { baseline?: unknown } | undefined>
  return { left: parseBaseline(sides.left?.baseline), right: parseBaseline(sides.right?.baseline) }
}

function parseBaseline(raw: unknown): PresenceBaseline | null {
  if (!raw || typeof raw !== 'object') return null
  const { format, means, threshold, ref_mean: refMean } = raw as Record<string, unknown>
  if (format !== 'capSense' && format !== 'capSense2') return null
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0) return null
  const channels = format === 'capSense' ? ['out', 'cen', 'in'] : ['A', 'B', 'C']
  if (!means || typeof means !== 'object') return null
  const m = means as Record<string, unknown>
  if (!channels.every(ch => typeof m[ch] === 'number' && Number.isFinite(m[ch]))) return null
  return {
    format,
    means: Object.fromEntries(channels.map(ch => [ch, m[ch] as number])),
    threshold,
    refMean: typeof refMean === 'number' && Number.isFinite(refMean) ? refMean : null,
  }
}

/**
 * The load on one side: summed signed rise of its channels over the empty-bed
 * baseline, or null when the frame can't be read against it (wrong format,
 * too few channels, a sentinel or a non-finite reading). `values` is the
 * live snapshot's flat channel array: capSense projects {out, cen, in} to
 * [out, out, cen, cen, in, in]; capSense2 sends [A1, A2, B1, B2, C1, C2, ref1, ref2].
 */
export function bedLoad(frameType: string, values: number | number[], baseline: PresenceBaseline): number | null {
  if (frameType !== baseline.format || !Array.isArray(values) || values.length < 6) return null
  let load: number
  if (baseline.format === 'capSense') {
    const [out, , cen, , inner] = values
    load = out - baseline.means.out + cen - baseline.means.cen + inner - baseline.means.in
  }
  else {
    const used = values.length >= 8 ? values.slice(0, 8) : values.slice(0, 6)
    if (used.includes(CAPSENSE2_SENTINEL)) return null
    const refDelta = values.length >= 8 ? (values[6] + values[7]) / 2 - (baseline.refMean ?? CAPSENSE2_REF_NOMINAL) : 0
    const pair = (i: number) => (values[i] + values[i + 1]) / 2 - refDelta
    load = pair(0) - baseline.means.A + pair(2) - baseline.means.B + pair(4) - baseline.means.C
  }
  // A NaN or infinite channel reads as no reading, not as an empty bed.
  return Number.isFinite(load) ? load : null
}

/** Instant presence for a load: enters above `threshold`, leaves below `exitFraction` of it. */
export function instantPresence(load: number, threshold: number, wasPresent: boolean, exitFraction = EXIT_FRACTION): boolean {
  return load > (wasPresent ? threshold * exitFraction : threshold)
}

export interface PresenceState {
  /** Presence after the hold; null while unknown. */
  inBed: boolean | null
  /** Epoch ms the current `inBed` state began (its first reading). */
  since: number | null
}

/**
 * Applies the hold to one side's instant presence. A change counts once it
 * has lasted `holdMs`; a reversal within the hold cancels it. With no hold the
 * state follows the instant reading.
 */
export class PresenceHold {
  private state: PresenceState = { inBed: null, since: null }
  private pending: { value: boolean, since: number } | null = null

  constructor(private holdMs = 0) {}

  setHold(holdMs: number): void {
    this.holdMs = Math.max(0, holdMs)
  }

  get current(): PresenceState {
    return this.state
  }

  /** Feed one reading (null = unknown). Returns true when the state changed. */
  update(instant: boolean | null, atMs: number): boolean {
    if (instant === null) {
      this.pending = null
      if (this.state.inBed === null) return false
      this.state = { inBed: null, since: null }
      return true
    }
    if (this.state.inBed === null) {
      // First reading after unknown: nothing to hold against.
      this.pending = null
      this.state = { inBed: instant, since: atMs }
      return true
    }
    if (instant === this.state.inBed) {
      this.pending = null
      return false
    }
    if (this.pending?.value !== instant) this.pending = { value: instant, since: atMs }
    if (atMs - this.pending.since < this.holdMs) return false
    this.state = { inBed: instant, since: this.pending.since }
    this.pending = null
    return true
  }
}
