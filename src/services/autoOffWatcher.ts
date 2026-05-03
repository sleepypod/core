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
import { deviceSettings, sideSettings, deviceState, runOnceSessions } from '@/src/db/schema'
import { sleepRecords } from '@/src/db/biometrics-schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
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

interface SideConfig {
  enabled: boolean
  minutes: number
  alwaysOn: boolean
}

/** Read auto-off config for both sides. */
function getAutoOffConfig(): Record<Side, SideConfig> {
  const defaults: SideConfig = { enabled: false, minutes: 30, alwaysOn: false }
  try {
    const rows = db.select().from(sideSettings).all()
    const left = rows.find(r => r.side === 'left')
    const right = rows.find(r => r.side === 'right')
    return {
      left: {
        enabled: left?.autoOffEnabled ?? defaults.enabled,
        minutes: left?.autoOffMinutes ?? defaults.minutes,
        alwaysOn: left?.alwaysOn ?? defaults.alwaysOn,
      },
      right: {
        enabled: right?.autoOffEnabled ?? defaults.enabled,
        minutes: right?.autoOffMinutes ?? defaults.minutes,
        alwaysOn: right?.alwaysOn ?? defaults.alwaysOn,
      },
    }
  }
  catch {
    return { left: defaults, right: defaults }
  }
}

/**
 * Read the global wall-clock auto-off cap (device_settings.globalMaxOnHours).
 * Returns null when disabled or on error.
 */
function getGlobalMaxOnHours(): number | null {
  try {
    const [row] = db
      .select({ globalMaxOnHours: deviceSettings.globalMaxOnHours })
      .from(deviceSettings)
      .limit(1)
      .all()
    return row?.globalMaxOnHours ?? null
  }
  catch {
    return null
  }
}

/** Read poweredOnAt (ms epoch) for a side, or null. */
function getPoweredOnAtMs(side: Side): number | null {
  try {
    const [row] = db
      .select({ poweredOnAt: deviceState.poweredOnAt })
      .from(deviceState)
      .where(eq(deviceState.side, side))
      .limit(1)
      .all()
    const v = row?.poweredOnAt
    if (!v) return null
    return v instanceof Date ? v.getTime() : (v as number) * 1000
  }
  catch {
    return null
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
    markSideMutated(side)
    const client = getSharedHardwareClient()
    await client.connect()
    await client.setPower(side, false)

    // Best-effort DB sync — also clear poweredOnAt so the global cap doesn't
    // see a stale "powered on X hours ago" after the side comes back on later
    // via a path that doesn't stamp through deviceStateSync.
    try {
      db.update(deviceState)
        .set({
          isPowered: false,
          poweredOnAt: null,
          targetTemperature: null,
          lastUpdated: new Date(),
        })
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
function evaluateSide(
  side: Side,
  config: Record<Side, SideConfig>,
  globalMaxOnHours: number | null,
): void {
  const cfg = config[side]

  // Side already off — nothing to evaluate for either cap
  if (!isSidePowered(side)) {
    clearSideTimer(side)
    return
  }

  // Run-once and always-on exempt a side from BOTH the per-side timer and
  // the global cap. Run-once is the user's explicit "keep on until X"; the
  // always-on flag is the perpetual-stay-on directive.
  if (hasActiveRunOnce(side) || cfg.alwaysOn) {
    clearSideTimer(side)
    return
  }

  // ── Global wall-clock cap (runs independently of sleep_records) ──────────
  // If a side has been powered for > globalMaxOnHours, force it off. This is
  // the safety net that fires even when the biometrics pipeline is broken or
  // the sleep-detector missed a bed-exit.
  if (globalMaxOnHours != null && globalMaxOnHours > 0) {
    const poweredOnAtMs = getPoweredOnAtMs(side)
    if (poweredOnAtMs != null) {
      const msSincePowerOn = Date.now() - poweredOnAtMs
      const capMs = globalMaxOnHours * 3600_000
      // Clock-sanity guard: skip the cap if poweredOnAt is in the future
      // (NTP reset, clock drift). The 7-day upper bound protects against a
      // stale row from a pre-2024 clock-seeded migration.
      const suspicious = msSincePowerOn < 0 || msSincePowerOn > 7 * 86_400_000
      if (!suspicious && msSincePowerOn > capMs) {
        console.log(
          `[auto-off] ${side}: global max-on cap exceeded (${globalMaxOnHours}h), powering off`,
        )
        clearSideTimer(side)
        firePowerOff(side)
        return
      }
    }
  }

  // ── Per-side bed-exit timer ──────────────────────────────────────────────
  // Feature disabled for this side
  if (!cfg.enabled) {
    clearSideTimer(side)
    return
  }

  const record = getLatestSleepRecord(side)
  if (!record) {
    // No sleep records yet — cannot determine presence for the bed-exit path.
    // The global cap above still applies independently.
    clearSideTimer(side)
    return
  }

  // Don't arm if the user has returned to bed
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
  const msSinceBedExit = nowMs - leftBedAtMs

  // If past the timeout, fire immediately. Previously this branch was gated
  // by `msSinceBedExit <= timeoutMs + 2 * POLL_INTERVAL_MS`; that "grace
  // window" would give up past ~32min and leave the side on forever when
  // the user left bed long ago and didn't return. The global cap is the
  // catch-all for wall-clock staleness; here we just fire on any past-due
  // bed-exit so long as the user hasn't re-entered bed.
  if (msSinceBedExit > timeoutMs) {
    clearSideTimer(side)
    // Re-check conditions before actually powering off
    if (!isSidePowered(side)) return
    if (hasActiveRunOnce(side)) return
    if (isUserInBed(side)) return
    const freshConfig = getAutoOffConfig()
    if (!freshConfig[side].enabled || freshConfig[side].alwaysOn) return

    console.log(
      `[auto-off] ${side}: bed exit ${Math.round(msSinceBedExit / 1000)}s ago (past ${cfg.minutes}min timeout), powering off`,
    )
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
      if (!freshConfig[side].enabled || freshConfig[side].alwaysOn) return

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
  const globalMaxOnHours = getGlobalMaxOnHours()
  for (const side of SIDES) {
    try {
      evaluateSide(side, config, globalMaxOnHours)
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
