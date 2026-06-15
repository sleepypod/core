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
}

const windows: Record<Side, WindowAccumulator | null> = { left: null, right: null }
let lastPruneMs = 0

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

/**
 * Feed one per-side capacitive reading from the live broadcast loop. `raw` is the
 * frame's `left`/`right` channel value (scalar for Pod 3, the raw 8-channel array
 * for capSense2). `tsSeconds` is the firmware frame timestamp (epoch seconds).
 * Flushes a downsampled row whenever the window rolls over.
 */
export function recordCapFrame(side: Side, raw: number | number[], tsSeconds: number): void {
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
}
