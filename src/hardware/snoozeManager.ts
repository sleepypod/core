/**
 * Manages alarm snooze timeouts per side.
 * Snooze = clear alarm immediately, re-trigger after duration expires.
 *
 * Snooze map lives on globalThis: Turbopack bundles this module into both
 * the instrumentation chunk (homekit snoozeSwitch sets it) and the API
 * chunks (device router reads it), so per-chunk `const map = new Map()`
 * would silently keep them in separate Maps.
 *
 * Pending snoozes are also persisted (alarmPersistence) and restored on
 * startup by restoreSnoozes, so a restart during a snooze doesn't swallow
 * the alarm.
 */
import { getSharedHardwareClient } from './dacMonitor.instance'
import { loadAlarmState, updateAlarmState, type AlarmConfig } from './alarmPersistence'
import { markAlarmStarted } from './alarmState'
export { MIN_SNOOZE_SECONDS, nextSnoozeSeconds } from './snoozeLength'
import type { Side } from './types'
import { withSideLock } from './sideLock'
import { outsideControlRequest } from '@/src/controls/context'

/** A snooze whose restart was missed by at most this much (the server was
 * down) still fires on startup; a later one is dropped. */
export const SNOOZE_LATE_GRACE_MS = 10 * 60 * 1000

interface SnoozeState {
  timeoutId: ReturnType<typeof setTimeout>
  snoozeUntil: Date
  config: AlarmConfig
}

const G = globalThis as Record<string, unknown>
const SNOOZE_KEY = '__sp_snooze_active__'

function getActiveSnoozes(): Map<Side, SnoozeState> {
  let m = G[SNOOZE_KEY] as Map<Side, SnoozeState> | undefined
  if (!m) {
    m = new Map<Side, SnoozeState>()
    G[SNOOZE_KEY] = m
  }
  return m
}

// Clamp to setTimeout's 32-bit ms ceiling — a larger delay wraps and the
// alarm restarts immediately instead of after the snooze. (The tRPC route
// caps duration at 1800s; this guards other callers.)
const MAX_DELAY_MS = 2 ** 31 - 1

function schedule(side: Side, snoozeUntil: Date, config: AlarmConfig, now: number): void {
  const state: SnoozeState = {
    snoozeUntil, config,
    timeoutId: outsideControlRequest(() => setTimeout(async () => {
      try {
        await withSideLock(side, async () => {
          // Cancellation/replacement can happen after the timer fires while its
          // write waits for another side operation. Only the current alarm runs.
          if (getActiveSnoozes().get(side) !== state) return
          getActiveSnoozes().delete(side)
          updateAlarmState((persisted) => {
            persisted.snoozes[side] = undefined
          })
          if (Date.now() - snoozeUntil.getTime() > SNOOZE_LATE_GRACE_MS) return
          const client = getSharedHardwareClient()
          await client.setAlarm(side, config)
          await markAlarmStarted(side, config)
        })
      }
      catch (error) {
        console.error(`[Snooze] Failed to restart alarm for ${side}:`, error)
      }
    }, Math.min(Math.max(0, snoozeUntil.getTime() - now), MAX_DELAY_MS))),
  }
  getActiveSnoozes().set(side, state)
}

export function snoozeAlarm(
  side: Side,
  durationSeconds: number,
  config: AlarmConfig,
): Date {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error('Invalid snooze duration')
  // Cancel any existing snooze for this side
  cancelSnooze(side)

  durationSeconds = Math.min(durationSeconds, Math.floor(MAX_DELAY_MS / 1000))
  const now = Date.now()
  const snoozeUntil = new Date(now + durationSeconds * 1000)
  // The alarm comes back counting this snooze, so a tapered next one is shorter.
  const count = Number.isSafeInteger(config.snoozeCount) && (config.snoozeCount ?? 0) >= 0 ? config.snoozeCount ?? 0 : 0
  const restart = { ...config, snoozeCount: Math.min(count + 1, Number.MAX_SAFE_INTEGER) }
  schedule(side, snoozeUntil, restart, now)
  updateAlarmState((s) => {
    s.snoozes[side] = { until: snoozeUntil.getTime(), config: restart }
  })
  return snoozeUntil
}

export function cancelSnooze(side: Side): void {
  const map = getActiveSnoozes()
  const existing = map.get(side)
  if (existing) {
    clearTimeout(existing.timeoutId)
    map.delete(side)
  }
  if (loadAlarmState().snoozes[side]) {
    updateAlarmState((s) => {
      s.snoozes[side] = undefined
    })
  }
}

/**
 * Startup: re-arm snoozes persisted by a previous process. One whose restart
 * time passed while the server was down fires now if it is at most
 * SNOOZE_LATE_GRACE_MS late, and is dropped otherwise.
 */
export function restoreSnoozes(now = Date.now()): void {
  const persisted = loadAlarmState().snoozes
  for (const side of ['left', 'right'] as const) {
    const entry = persisted[side]
    if (!entry || getActiveSnoozes().has(side)) continue
    if (now - entry.until > SNOOZE_LATE_GRACE_MS) {
      updateAlarmState((s) => {
        s.snoozes[side] = undefined
      })
      continue
    }
    schedule(side, new Date(entry.until), entry.config, now)
  }
}

/**
 * Shutdown: stop this process's snooze timers but keep them persisted, so
 * the next process restores them (restoreSnoozes).
 */
export function suspendSnoozes(): void {
  const map = getActiveSnoozes()
  for (const state of map.values()) clearTimeout(state.timeoutId)
  map.clear()
}

export function getSnoozeStatus(side: Side): { active: boolean, snoozeUntil: number | null } {
  const state = getActiveSnoozes().get(side)
  return {
    active: !!state,
    snoozeUntil: state ? Math.floor(state.snoozeUntil.getTime() / 1000) : null,
  }
}
