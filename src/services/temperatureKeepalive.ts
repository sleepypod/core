/**
 * Temperature Keepalive Service
 *
 * The pod firmware requires a `duration` parameter with every temperature command.
 * After the duration expires (~8 hours / 28800s), the pod returns to neutral (82.5F).
 * This service periodically re-sends the current target temperature to reset the
 * firmware's duration timer, enabling 24/7 temperature control.
 *
 * Keepalive interval: 6 hours (21600s) — well within the 8-hour firmware limit.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState, sideSettings } from '@/src/db/schema'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import type { Side } from '@/src/hardware/types'

const KEEPALIVE_INTERVAL_MS = 6 * 60 * 60 * 1000 // 6 hours in milliseconds

const timers = new Map<Side, ReturnType<typeof setInterval>>()

/**
 * Start the keepalive timer for a side. If the side is powered on and has
 * a target temperature, periodically re-sends setTemperature to reset the
 * firmware's duration counter.
 *
 * Idempotent — stops any existing timer for the side before starting a new one.
 */
export function startKeepalive(side: Side): void {
  stopKeepalive(side)

  const tick = async () => {
    try {
      // Read current device state to get target temperature
      const [state] = db
        .select()
        .from(deviceState)
        .where(eq(deviceState.side, side))
        .limit(1)
        .all()

      if (!state || !state.isPowered || state.targetTemperature == null) {
        // Side is off or has no target — nothing to keepalive
        return
      }

      // Verify alwaysOn is still enabled (may have been toggled off between ticks)
      const [settings] = db
        .select()
        .from(sideSettings)
        .where(eq(sideSettings.side, side))
        .limit(1)
        .all()

      if (!settings?.alwaysOn) {
        stopKeepalive(side)
        return
      }

      const client = getSharedHardwareClient()
      await client.connect()
      await client.setTemperature(side, state.targetTemperature)
      console.log(`[keepalive] Re-sent temperature ${state.targetTemperature}°F for ${side}`)
    }
    catch (error) {
      console.error(
        `[keepalive] Failed to re-send temperature for ${side}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }

  // Fire immediately to reset firmware duration timer right away
  tick()

  const interval = setInterval(tick, KEEPALIVE_INTERVAL_MS)

  // Allow Node process to exit even if timer is running
  interval.unref()

  timers.set(side, interval)
  console.log(`[keepalive] Started for ${side} (interval: 6h)`)
}

/**
 * Stop the keepalive timer for a side.
 * No-op if no timer is active.
 */
export function stopKeepalive(side: Side): void {
  const timer = timers.get(side)
  if (timer) {
    clearInterval(timer)
    timers.delete(side)
    console.log(`[keepalive] Stopped for ${side}`)
  }
}

/**
 * Initialize keepalive timers for all sides that have alwaysOn enabled.
 * Called once at startup.
 */
export function initializeKeepalives(): void {
  const sides: Side[] = ['left', 'right']

  for (const side of sides) {
    try {
      const [settings] = db
        .select()
        .from(sideSettings)
        .where(eq(sideSettings.side, side))
        .limit(1)
        .all()

      if (settings?.alwaysOn) {
        startKeepalive(side)
      }
    }
    catch (error) {
      console.error(
        `[keepalive] Failed to initialize for ${side}:`,
        error instanceof Error ? error.message : error,
      )
    }
  }
}

/**
 * Stop all keepalive timers. Called during graceful shutdown.
 */
export function shutdownKeepalives(): void {
  for (const side of timers.keys()) {
    stopKeepalive(side)
  }
}
