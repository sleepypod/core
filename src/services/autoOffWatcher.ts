/**
 * Auto-Off Watcher Service
 *
 * Polls the biometrics DB `sleep_records` table for bed-exit events.
 * When a side has no presence for longer than `autoOffMinutes`, powers
 * off that side via the shared hardware client.
 *
 * Per-side countdown timers reset on bed re-entry and cancel if the side
 * is already off or a run-once session is active.
 */

import { eq, and, desc } from 'drizzle-orm'
import { db, biometricsDb } from '@/src/db'
import { sideSettings, deviceState, runOnceSessions } from '@/src/db/schema'
import { sleepRecords } from '@/src/db/biometrics-schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000 // 30 seconds
const SIDES = ['left', 'right'] as const
type Side = (typeof SIDES)[number]

// ---------------------------------------------------------------------------
// Per-side timer state
// ---------------------------------------------------------------------------

interface SideTimer {
  /** setTimeout handle for the pending auto-off */
  timer: ReturnType<typeof setTimeout> | null
  /** Unix-ms when the timer was started (bed-exit time) */
  startedAt: number | null
  /** The configured timeout in ms when the timer was created */
  timeoutMs: number | null
}

const timers: Record<Side, SideTimer> = {
  left: { timer: null, startedAt: null, timeoutMs: null },
  right: { timer: null, startedAt: null, timeoutMs: null },
}

let pollHandle: ReturnType<typeof setInterval> | null = null

/** Track in-flight powerOffSide() calls so shutdown can await them. */
const pendingPowerOffs = new Set<Promise<void>>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearSideTimer(side: Side): void {
  const t = timers[side]
  if (t.timer) {
    clearTimeout(t.timer)
    t.timer = null
    t.startedAt = null
    t.timeoutMs = null
  }
}

/** Check whether the side currently has power. */
function isSidePowered(side: Side): boolean {
  try {
    const [row] = db
      .select({ isPowered: deviceState.isPowered })
      .from(deviceState)
      .where(eq(deviceState.side, side))
      .limit(1)
      .all()
    return row?.isPowered ?? false
  }
  catch {
    return false
  }
}

/** Check whether a run-once session is active for this side. */
function hasActiveRunOnce(side: Side): boolean {
  try {
    const [row] = db
      .select({ id: runOnceSessions.id })
      .from(runOnceSessions)
      .where(
        and(
          eq(runOnceSessions.side, side),
          eq(runOnceSessions.status, 'active'),
        ),
      )
      .limit(1)
      .all()
    return !!row
  }
  catch {
    return false
  }
}

/** Read auto-off config for both sides. */
function getAutoOffConfig(): Record<Side, { enabled: boolean, minutes: number }> {
  const defaults = { enabled: false, minutes: 30 }
  try {
    const rows = db.select().from(sideSettings).all()
    const left = rows.find(r => r.side === 'left')
    const right = rows.find(r => r.side === 'right')
    return {
      left: {
        enabled: left?.autoOffEnabled ?? defaults.enabled,
        minutes: left?.autoOffMinutes ?? defaults.minutes,
      },
      right: {
        enabled: right?.autoOffEnabled ?? defaults.enabled,
        minutes: right?.autoOffMinutes ?? defaults.minutes,
      },
    }
  }
  catch {
    return { left: defaults, right: defaults }
  }
}

/**
 * Get the most recent sleep record for a side.
 * Returns the record or null if none exists.
 */
function getLatestSleepRecord(side: Side) {
  try {
    const [row] = biometricsDb
      .select()
      .from(sleepRecords)
      .where(eq(sleepRecords.side, side))
      .orderBy(desc(sleepRecords.leftBedAt))
      .limit(1)
      .all()
    return row ?? null
  }
  catch {
    return null
  }
}

/**
 * Check whether the user is currently in bed by comparing enteredBedAt
 * and leftBedAt from the latest sleep record. If `enteredBedAt > leftBedAt`,
 * a new session started after the last exit — the user is back in bed.
 */
function isUserInBed(side: Side): boolean {
  const record = getLatestSleepRecord(side)
  if (!record) return false

  const enteredMs = record.enteredBedAt instanceof Date
    ? record.enteredBedAt.getTime()
    : (record.enteredBedAt as number) * 1000
  const leftMs = record.leftBedAt instanceof Date
    ? record.leftBedAt.getTime()
    : (record.leftBedAt as number) * 1000

  return enteredMs > leftMs
}

/** Power off a side via the shared hardware client. */
async function powerOffSide(side: Side): Promise<void> {
  try {
    const client = getSharedHardwareClient()
    await client.connect()
    await client.setPower(side, false)

    // Best-effort DB sync
    try {
      db.update(deviceState)
        .set({ isPowered: false, lastUpdated: new Date() })
        .where(eq(deviceState.side, side))
        .run()
    }
    catch {
      // next status poll will re-sync
    }

    broadcastMutationStatus(side, { targetLevel: 0 })
    console.log(`[auto-off] Powered off ${side} side (no presence detected)`)
  }
  catch (error) {
    console.error(
      `[auto-off] Failed to power off ${side}:`,
      error instanceof Error ? error.message : error,
    )
  }
}

/**
 * Fire powerOffSide and track the promise so shutdown can await it.
 */
function firePowerOff(side: Side): void {
  const p = powerOffSide(side).finally(() => {
    pendingPowerOffs.delete(p)
  })
  pendingPowerOffs.add(p)
}

// ---------------------------------------------------------------------------
// Core poll logic
// ---------------------------------------------------------------------------

/**
 * Determine whether a side currently has bed presence.
 *
 * The sleep-detector writes a `sleep_records` row when a session ends
 * (i.e. the person has left the bed). If the most recent record's
 * `leftBedAt` is recent (within the poll window), we consider
 * presence lost. If there is no record or the most recent exit was
 * long ago and the side is still powered, we assume they are in bed
 * (the session hasn't closed yet).
 */
function evaluateSide(side: Side, config: Record<Side, { enabled: boolean, minutes: number }>): void {
  const cfg = config[side]

  // Feature disabled for this side
  if (!cfg.enabled) {
    clearSideTimer(side)
    return
  }

  // Side already off -- nothing to do
  if (!isSidePowered(side)) {
    clearSideTimer(side)
    return
  }

  // Suppress if a run-once session is active
  if (hasActiveRunOnce(side)) {
    clearSideTimer(side)
    return
  }

  const record = getLatestSleepRecord(side)
  if (!record) {
    // No sleep records yet -- cannot determine presence
    clearSideTimer(side)
    return
  }

  // Fix 1: Don't arm if the user has returned to bed
  // (enteredBedAt > leftBedAt means a new session started after the exit)
  if (isUserInBed(side)) {
    clearSideTimer(side)
    return
  }

  const leftBedAtMs = record.leftBedAt instanceof Date
    ? record.leftBedAt.getTime()
    : (record.leftBedAt as number) * 1000
  const nowMs = Date.now()
  const timeoutMs = cfg.minutes * 60_000

  // If the most recent bed exit is in the future or very recent
  // and we don't have a timer yet, start one.
  const msSinceBedExit = nowMs - leftBedAtMs

  // Check: has the person re-entered bed since this exit?
  // If the sleep_records entry has been superseded by a newer entry with
  // enteredBedAt > leftBedAt of the previous record, the person is back in bed.
  // The sleep-detector only writes a record when a session ENDS, so if the side
  // is powered and the most recent record's leftBedAt was long ago, a new session
  // may be in progress (person is currently in bed).
  // Heuristic: if leftBedAt is older than the timeout, the timer should have
  // already fired. If the side is still on, either it was manually turned on
  // or a new session is in progress -- don't start a new timer.
  // Fix 5: Add grace window for server restarts during countdown.
  // If msSinceBedExit is within timeoutMs + 2 * POLL_INTERVAL_MS, the timer
  // may have been lost during a restart — fire immediately rather than skip.
  const graceMs = timeoutMs + 2 * POLL_INTERVAL_MS
  if (msSinceBedExit > graceMs) {
    clearSideTimer(side)
    return
  }

  // Fix 5: If past the timeout but within the grace window, fire immediately
  if (msSinceBedExit > timeoutMs) {
    clearSideTimer(side)
    // Re-check conditions before actually powering off
    if (!isSidePowered(side)) return
    if (hasActiveRunOnce(side)) return
    if (isUserInBed(side)) return
    const freshConfig = getAutoOffConfig()
    if (!freshConfig[side].enabled) return

    console.log(`[auto-off] ${side}: bed exit was ${Math.round(msSinceBedExit / 1000)}s ago (within grace window), firing immediately`)
    firePowerOff(side)
    return
  }

  // Bed exit is recent -- check if we need to start or update a timer
  const existing = timers[side]

  if (existing.timer) {
    // Timer already running. If it targets the same bed-exit event, keep it.
    // If the config (minutes) changed, restart with the new timeout.
    if (existing.startedAt === leftBedAtMs && existing.timeoutMs === timeoutMs) {
      return // timer is correct
    }
    // Config changed or different exit event -- restart
    clearSideTimer(side)
  }

  // Start countdown timer
  const remainingMs = Math.max(0, timeoutMs - msSinceBedExit)
  console.log(
    `[auto-off] ${side}: bed exit detected, auto-off in ${Math.round(remainingMs / 1000)}s`,
  )

  timers[side] = {
    timer: setTimeout(() => {
      timers[side] = { timer: null, startedAt: null, timeoutMs: null }
      // Re-check conditions before actually powering off
      if (!isSidePowered(side)) return
      if (hasActiveRunOnce(side)) return
      const freshConfig = getAutoOffConfig()
      if (!freshConfig[side].enabled) return

      // Verify the bed-exit that armed this timer is still the latest
      const latestRecord = getLatestSleepRecord(side)
      if (latestRecord) {
        const latestLeftBedMs = latestRecord.leftBedAt instanceof Date
          ? latestRecord.leftBedAt.getTime()
          : (latestRecord.leftBedAt as number) * 1000
        if (latestLeftBedMs !== leftBedAtMs) return // newer event; evaluateSide will re-arm
      }

      // Fix 1: Check live presence before firing — user may have returned
      if (isUserInBed(side)) {
        console.log(`[auto-off] ${side}: user returned to bed, skipping power-off`)
        return
      }

      firePowerOff(side)
    }, remainingMs),
    startedAt: leftBedAtMs,
    timeoutMs,
  }
}

function poll(): void {
  const config = getAutoOffConfig()
  for (const side of SIDES) {
    try {
      evaluateSide(side, config)
    }
    catch (error) {
      console.error(
        `[auto-off] Error evaluating ${side}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Start the auto-off watcher polling loop. */
export function startAutoOffWatcher(): void {
  if (pollHandle) return // already running
  console.log('[auto-off] Watcher started (poll every 30s)')
  poll() // initial evaluation
  pollHandle = setInterval(poll, POLL_INTERVAL_MS)
}

/** Stop the watcher, clear all pending timers, and await in-flight power-offs. */
export async function stopAutoOffWatcher(): Promise<void> {
  if (pollHandle) {
    clearInterval(pollHandle)
    pollHandle = null
  }
  clearSideTimer('left')
  clearSideTimer('right')

  // Await any in-flight powerOffSide() calls
  if (pendingPowerOffs.size > 0) {
    console.log(`[auto-off] Waiting for ${pendingPowerOffs.size} in-flight power-off(s)...`)
    await Promise.allSettled([...pendingPowerOffs])
  }

  console.log('[auto-off] Watcher stopped')
}

/**
 * Restart timers after settings change.
 * Called when autoOffEnabled or autoOffMinutes is updated via the API.
 */
export function restartAutoOffTimers(): void {
  // Fix 3: Don't poll if watcher is not running (e.g. in CI)
  if (!pollHandle) return

  clearSideTimer('left')
  clearSideTimer('right')
  poll()
}

/**
 * Cancel the auto-off timer for a specific side without re-evaluating.
 * Called when a scheduled power-on fires — the side is being turned on
 * intentionally, so any pending auto-off countdown should be aborted.
 */
export function cancelAutoOffTimer(side: Side): void {
  if (timers[side].timer) {
    console.log(`[auto-off] ${side}: timer cancelled (scheduled power-on)`)
    clearSideTimer(side)
  }
}
