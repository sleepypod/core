/**
 * Downsampling writer for the capacitive presence matrix.
 *
 * The live broadcast loop sees capSense / capSense2 frames at ~2 Hz but never
 * persists them — `signals.biometrics` reads only the in-memory snapshot. This
 * module accumulates those frames into a fixed time window (per side) and flushes
 * one aggregated row to `cap_sense_frames` per window, so the spatial zone replay
 * and `cap.*` backtest can reach recent nights without storing every raw frame.
 *
 * Windowing keys off the firmware frame timestamp, not wall clock, so a stream
 * catching up after a gap downsamples correctly instead of collapsing a burst.
 * Old rows are pruned to ~48h — this is the bulkiest sensor stream and only the
 * last night or two is ever replayed.
 */

import { lte } from 'drizzle-orm'
import { biometricsDb } from '@/src/db'
import { capSenseFrames } from '@/src/db/biometrics-schema'
import { reduceCap, zoneTriple } from '@/src/automation/capReduce'

const WINDOW_MS = 5_000
const RETENTION_MS = 48 * 60 * 60_000
const PRUNE_INTERVAL_MS = 10 * 60_000
const MIN_VALID_WALL_CLOCK_TS_SECONDS = 1_577_836_800 // 2020-01-01 00:00:00 UTC
const MAX_FUTURE_SKEW_SECONDS = 60

type Side = 'left' | 'right'

interface WindowAccumulator {
  startTsMs: number
  lastTsMs: number
  n: number
  maxSum: number
  meanSum: number
  spreadSum: number
  zoneSums: [number, number, number] | null
  peakCounts: [number, number, number]
  // Per-sample `status` histogram for this side/window. Only the NATS capSense
  // dialect carries a status; legacy .RAW frames leave this empty.
  statusCounts: Record<string, number>
  // Whether any sample in the window was non-"good". Drives whether the
  // histogram is persisted at all — an all-"good" (or statusless) window keeps
  // statusCounts null so the common case costs nothing.
  sawNonGood: boolean
}

const windows: Record<Side, WindowAccumulator | null> = { left: null, right: null }
let lastPruneMs = 0

// Distinct non-"good" statuses already logged this process, so the first sight
// of each new value surfaces its channel values once (journald → sp-bundle-logs)
// without spamming every subsequent frame.
const loggedNonGoodStatuses = new Set<string>()

function freshWindow(tsMs: number): WindowAccumulator {
  return {
    startTsMs: tsMs,
    lastTsMs: tsMs,
    n: 0,
    maxSum: 0,
    meanSum: 0,
    spreadSum: 0,
    zoneSums: null,
    peakCounts: [0, 0, 0],
    statusCounts: {},
    sawNonGood: false,
  }
}

export interface CapFrameRow {
  timestamp: Date
  zones: [number, number, number] | null
  max: number
  mean: number
  spread: number
  peakZone: number | null
  frameCount: number
  // Full `{status: sampleCount}` histogram (including "good") when any sample in
  // the window was non-"good"; null otherwise — see WindowAccumulator.sawNonGood.
  statusCounts: Record<string, number> | null
}

/** Collapse a filled window into the row shape written to `cap_sense_frames`. */
export function summarizeWindow(acc: WindowAccumulator): CapFrameRow {
  const zones: [number, number, number] | null = acc.zoneSums
    ? [acc.zoneSums[0] / acc.n, acc.zoneSums[1] / acc.n, acc.zoneSums[2] / acc.n]
    : null
  // Modal peak zone across the window — only meaningful when zones were present.
  const peakZone = acc.zoneSums
    ? acc.peakCounts.reduce((best, c, i, arr) => (c > arr[best] ? i : best), 0)
    : null
  return {
    timestamp: new Date(acc.lastTsMs),
    zones,
    max: acc.maxSum / acc.n,
    mean: acc.meanSum / acc.n,
    spread: acc.spreadSum / acc.n,
    peakZone,
    frameCount: acc.n,
    // Persist the histogram only when it carries signal — an all-"good" window
    // is stored as null so the common case adds no bytes.
    statusCounts: acc.sawNonGood ? acc.statusCounts : null,
  }
}

// Caller invariant: only ever called on rollover, when `acc` holds ≥1 frame.
function flush(side: Side, acc: WindowAccumulator): void {
  try {
    biometricsDb.insert(capSenseFrames)
      .values({ side, ...summarizeWindow(acc) })
      .onConflictDoNothing()
      .run()
  }
  catch (err) {
    // Persistence is best-effort: a write failure must never disrupt the live
    // stream. Surface rather than swallow silently.
    console.warn('[capFrames] flush failed:', err)
  }
}

function maybePrune(nowMs: number): void {
  if (nowMs - lastPruneMs < PRUNE_INTERVAL_MS) return
  lastPruneMs = nowMs
  try {
    biometricsDb.delete(capSenseFrames)
      .where(lte(capSenseFrames.timestamp, new Date(nowMs - RETENTION_MS)))
      .run()
  }
  catch (err) {
    console.warn('[capFrames] prune failed:', err)
  }
}

function isSaneFirmwareTimestamp(tsSeconds: number): boolean {
  if (!Number.isFinite(tsSeconds)) return false
  if (tsSeconds < MIN_VALID_WALL_CLOCK_TS_SECONDS) return false
  if (tsSeconds > Date.now() / 1000 + MAX_FUTURE_SKEW_SECONDS) return false
  return true
}

/**
 * Feed one per-side capacitive reading from the live broadcast loop. `raw` is the
 * frame's `left`/`right` channel value (scalar for Pod 3, the raw 8-channel array
 * for capSense2). `tsSeconds` is the firmware frame timestamp (epoch seconds).
 * `status` is the side's NATS-dialect quality tag ("good"/…); null/undefined on
 * legacy .RAW frames, which have none. Flushes a downsampled row whenever the
 * window rolls over.
 */
export function recordCapFrame(
  side: Side,
  raw: number | number[],
  tsSeconds: number,
  status?: string | null,
): void {
  if (!isSaneFirmwareTimestamp(tsSeconds)) return

  const tsMs = tsSeconds * 1000
  const values = Array.isArray(raw) ? raw : [raw]
  const r = reduceCap(values)
  if (!r) return

  let acc = windows[side]
  if (!acc) {
    acc = freshWindow(tsMs)
    windows[side] = acc
  }
  else if (tsMs - acc.startTsMs >= WINDOW_MS) {
    flush(side, acc)
    maybePrune(Date.now())
    acc = freshWindow(tsMs)
    windows[side] = acc
  }

  acc.n += 1
  acc.lastTsMs = tsMs
  acc.maxSum += r.max
  acc.meanSum += r.mean
  acc.spreadSum += r.spread
  const triple = zoneTriple(values)
  if (triple) {
    if (!acc.zoneSums) acc.zoneSums = [0, 0, 0]
    acc.zoneSums[0] += triple[0]
    acc.zoneSums[1] += triple[1]
    acc.zoneSums[2] += triple[2]
    if (r.peakZone != null) acc.peakCounts[r.peakZone] += 1
  }
  if (status) recordStatus(side, acc, status, values)
}

/**
 * Fold one sample's per-side `status` into the window histogram. Every observed
 * status is counted (so a mixed window is a true histogram); the first sight of
 * each distinct non-"good" value is logged once with its channel values, giving
 * field reports the evidence to define the future capSense.status gate.
 */
function recordStatus(side: Side, acc: WindowAccumulator, status: string, values: number[]): void {
  acc.statusCounts[status] = (acc.statusCounts[status] ?? 0) + 1
  if (status === 'good') return
  acc.sawNonGood = true
  // Dedup on the status value alone (process-wide): the first sighting of each
  // distinct non-"good" status logs once with whichever side/channels saw it.
  if (!loggedNonGoodStatuses.has(status)) {
    loggedNonGoodStatuses.add(status)
    console.warn('[capFrames] capSense %s status=%s channels=%j', side, status, values)
  }
}

/** Persist any non-empty in-flight windows, then clear them. */
export function flushCapFrameWindows(): void {
  let flushed = false
  for (const side of ['left', 'right'] as const) {
    const acc = windows[side]
    if (!acc || acc.n === 0) {
      windows[side] = null
      continue
    }
    flush(side, acc)
    flushed = true
    windows[side] = null
  }
  if (flushed) maybePrune(Date.now())
}

/** Reset accumulators — called when the active RAW file switches. */
export function resetCapFrameWindows(): void {
  windows.left = null
  windows.right = null
}

/** Test-only accessor for the in-flight per-side window state. */
export function _getCapFrameWindow(side: Side): WindowAccumulator | null {
  return windows[side]
}

/** Test-only reset of all module state (windows + prune throttle clock). */
export function _resetForTest(): void {
  windows.left = null
  windows.right = null
  lastPruneMs = 0
  loggedNonGoodStatuses.clear()
}
