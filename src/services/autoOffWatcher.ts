/**
 * Auto-Off Watcher Service
 *
 * Powers a side off after it has been empty for `autoOffMinutes`, using the
 * LIVE occupancy sensor (`src/lib/occupancy.ts`) — the same signal HomeKit and
 * the web PresenceCard use — rather than the `sleep_records` table.
 *
 * Why not sleep_records: the Python sleep-detector only writes a row when a
 * session CLOSES (both entered_bed_at and left_bed_at set, entered < left).
 * While someone is in bed no row exists for the current session, so the latest
 * row is the PREVIOUS night with an hours-old left_bed_at. Deriving presence
 * from that made the watcher think the bed had been empty for hours and power a
 * just-powered side off within seconds. See sleepypod-core-64.
 *
 * Fail-safe: auto-off only acts on a POSITIVE, reliable "empty" reading. If the
 * presence signal isn't available for a side (no fresh capacitance frame, or
 * no matching calibration — `getOccupancy().available === false`), the per-side
 * timer stands down entirely. Missing or inconsistent biometrics never trigger
 * a power-off; the global wall-clock cap remains the independent backstop.
 */

import { eq, and } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceSettings, sideSettings, deviceState, runOnceSessions } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { markSideMutated } from '@/src/hardware/deviceStateSync'
import { broadcastMutationStatus } from '@/src/streaming/broadcastMutationStatus'
import { getOccupancy } from '@/src/lib/occupancy'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 30_000 // 30 seconds
const SIDES = ['left', 'right'] as const
type Side = (typeof SIDES)[number]

// ---------------------------------------------------------------------------
// Per-side empty-since state
// ---------------------------------------------------------------------------

/**
 * Unix-ms when a side was first observed empty-while-sensable, or null when the
 * side is occupied, off, exempt, or presence can't be sensed. The countdown to
 * power-off is `now - emptySince >= autoOffMinutes`.
 */
const emptySince: Record<Side, number | null> = { left: null, right: null }

let pollHandle: ReturnType<typeof setInterval> | null = null

/** Track in-flight powerOffSide() calls so shutdown can await them. */
const pendingPowerOffs = new Set<Promise<void>>()

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset a side's empty-since stamp (occupied, off, exempt, or unsensable). */
function clearEmptySince(side: Side): void {
  emptySince[side] = null
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
 * Live presence for a side. Returns:
 *   'occupied'    — someone is in bed (movement or calibrated level signal)
 *   'empty'       — reliably sensed empty (level signal evaluable, not occupied)
 *   'unsensable'  — presence can't be sensed; auto-off must stand down
 */
function presenceState(side: Side): 'occupied' | 'empty' | 'unsensable' {
  try {
    const occ = getOccupancy(side)
    if (occ.occupied) return 'occupied'
    if (!occ.available) return 'unsensable'
    return 'empty'
  }
  catch {
    // Treat any failure to read presence as unsensable — fail safe.
    return 'unsensable'
  }
}

/** Power off a side via the shared hardware client. */
async function powerOffSide(side: Side): Promise<void> {
  try {
    const client = getSharedHardwareClient()
    await client.connect()
    await client.setPower(side, false)

    // Best-effort DB sync — also clear poweredOnAt so the global cap doesn't
    // see a stale "powered on X hours ago" after the side comes back on later
    // via a path that doesn't stamp through deviceStateSync.
    try {
      // Stamp freshness immediately before the DB write so the 5s guard
      // protects this mutation from concurrent DAC polls — placing it before
      // the slow hardware roundtrip risks the window expiring before the DB
      // update lands.
      markSideMutated(side)
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
  clearEmptySince(side)
  const p = powerOffSide(side).finally(() => {
    pendingPowerOffs.delete(p)
  })
  pendingPowerOffs.add(p)
}

// ---------------------------------------------------------------------------
// Core poll logic
// ---------------------------------------------------------------------------

function evaluateSide(
  side: Side,
  config: Record<Side, SideConfig>,
  globalMaxOnHours: number | null,
): void {
  const cfg = config[side]

  // Side already off — nothing to evaluate for either cap
  if (!isSidePowered(side)) {
    clearEmptySince(side)
    return
  }

  // Run-once and always-on exempt a side from BOTH the per-side timer and
  // the global cap. Run-once is the user's explicit "keep on until X"; the
  // always-on flag is the perpetual-stay-on directive.
  if (hasActiveRunOnce(side) || cfg.alwaysOn) {
    clearEmptySince(side)
    return
  }

  // ── Global wall-clock cap (runs independently of presence) ───────────────
  // If a side has been powered for > globalMaxOnHours, force it off. This is
  // the safety net that fires even when the biometrics pipeline is broken or
  // presence can't be sensed at all.
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
        firePowerOff(side)
        return
      }
    }
  }

  // ── Per-side presence-based auto-off ─────────────────────────────────────
  // Feature disabled for this side
  if (!cfg.enabled) {
    clearEmptySince(side)
    return
  }

  const presence = presenceState(side)

  // Fail-safe: if presence can't be sensed (no fresh capacitance frame / no
  // matching calibration), never auto-off on missing data. Reset the countdown so a
  // later loss of signal doesn't carry stale empty time. The global cap above
  // is the only thing that may still power a side off in this state.
  if (presence === 'unsensable') {
    clearEmptySince(side)
    return
  }

  // Live occupant — reset the countdown.
  if (presence === 'occupied') {
    clearEmptySince(side)
    return
  }

  // presence === 'empty' and reliably sensed. Stamp the first empty observation,
  // then fire once the bed has been continuously empty for the timeout.
  const now = Date.now()
  const since = emptySince[side]
  if (since == null) {
    emptySince[side] = now
    console.log(`[auto-off] ${side}: bed empty, auto-off in ${cfg.minutes}min if still empty`)
    return
  }

  const emptyMs = now - since
  const timeoutMs = cfg.minutes * 60_000
  if (emptyMs >= timeoutMs) {
    console.log(
      `[auto-off] ${side}: empty for ${Math.round(emptyMs / 1000)}s (past ${cfg.minutes}min timeout), powering off`,
    )
    firePowerOff(side)
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
  clearEmptySince('left')
  clearEmptySince('right')

  // Await any in-flight powerOffSide() calls
  if (pendingPowerOffs.size > 0) {
    console.log(`[auto-off] Waiting for ${pendingPowerOffs.size} in-flight power-off(s)...`)
    await Promise.allSettled([...pendingPowerOffs])
  }

  console.log('[auto-off] Watcher stopped')
}

/**
 * Re-evaluate after a settings change. Resets the empty-since countdown for
 * both sides so a freshly-changed timeout/enable starts clean, then polls.
 * Called when autoOffEnabled / autoOffMinutes / globalMaxOnHours is updated.
 */
export function restartAutoOffTimers(): void {
  // Don't poll if watcher is not running (e.g. in CI)
  if (!pollHandle) return

  clearEmptySince('left')
  clearEmptySince('right')
  poll()
}

/**
 * Cancel the auto-off countdown for a specific side without re-evaluating.
 * Called when a scheduled power-on fires — the side is being turned on
 * intentionally, so any pending auto-off countdown should be aborted.
 */
export function cancelAutoOffTimer(side: Side): void {
  if (emptySince[side] != null) {
    console.log(`[auto-off] ${side}: countdown cancelled (scheduled power-on)`)
    clearEmptySince(side)
  }
}
