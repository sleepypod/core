/**
 * Which side's alarm is vibrating, with what settings, until when.
 *
 * device_state.isAlarmVibrating is what a tap gesture checks to decide
 * whether it snoozes or dismisses an alarm (the firmware's status doesn't
 * report vibration). Every path that starts an alarm — the schedule, the
 * API, a snooze restarting — calls markAlarmStarted, and every path that
 * stops one calls markAlarmEnded. An alarm nobody stops ends when its
 * duration runs out, so the flag can't stay set for a later tap to "snooze"
 * an alarm that finished long ago. Active alarms are persisted (see
 * alarmPersistence) and restored on startup.
 */
import { eq } from 'drizzle-orm'
import { db } from '@/src/db'
import { deviceState } from '@/src/db/schema'
import { loadAlarmState, updateAlarmState, type AlarmConfig } from './alarmPersistence'
import type { Side } from './types'

export type { AlarmConfig } from './alarmPersistence'

interface ActiveAlarm {
  config: AlarmConfig
  until: number
  timer: ReturnType<typeof setTimeout>
}

const G = globalThis as Record<string, unknown>
const KEY = '__sp_active_alarms__'

function active(): Map<Side, ActiveAlarm> {
  let m = G[KEY] as Map<Side, ActiveAlarm> | undefined
  if (!m) {
    m = new Map<Side, ActiveAlarm>()
    G[KEY] = m
  }
  return m
}

async function publish(side: Side, vibrating: boolean): Promise<void> {
  try {
    await db
      .update(deviceState)
      .set({ isAlarmVibrating: vibrating, lastUpdated: new Date() })
      .where(eq(deviceState.side, side))
  }
  catch (err) {
    console.error(`[alarmState] failed to store alarm state for ${side}:`, err instanceof Error ? err.message : err)
  }
  const { broadcastMutationStatus } = await import('@/src/streaming/broadcastMutationStatus')
  broadcastMutationStatus(side, { isAlarmVibrating: vibrating })
}

function arm(side: Side, config: AlarmConfig, until: number, now: number): void {
  const existing = active().get(side)
  if (existing) clearTimeout(existing.timer)
  const timer = setTimeout(() => {
    void markAlarmEnded(side)
  }, Math.max(0, until - now))
  active().set(side, { config, until, timer })
}

/** An alarm just started vibrating on `side` (after the hardware command). */
export async function markAlarmStarted(side: Side, config: AlarmConfig, now = Date.now()): Promise<void> {
  const until = now + config.duration * 1000
  arm(side, config, until, now)
  updateAlarmState((s) => {
    s.alarms[side] = { until, config }
  })
  await publish(side, true)
}

/** The alarm on `side` stopped: dismissed, snoozed, cut short, or done. */
export async function markAlarmEnded(side: Side): Promise<void> {
  const existing = active().get(side)
  if (existing) clearTimeout(existing.timer)
  active().delete(side)
  if (loadAlarmState().alarms[side]) {
    updateAlarmState((s) => {
      s.alarms[side] = undefined
    })
  }
  await publish(side, false)
}

/** Settings of the alarm vibrating on `side` now, or null. */
export function getActiveAlarmConfig(side: Side): AlarmConfig | null {
  return active().get(side)?.config ?? null
}

/**
 * Startup: an alarm still inside its duration keeps its flag and end timer;
 * any other flag left set by a process that stopped mid-alarm is cleared.
 */
export async function restoreActiveAlarms(now = Date.now()): Promise<void> {
  const persisted = loadAlarmState().alarms
  for (const side of ['left', 'right'] as const) {
    const entry = persisted[side]
    if (entry && entry.until > now) {
      arm(side, entry.config, entry.until, now)
      await publish(side, true)
    }
    else {
      await markAlarmEnded(side)
    }
  }
}

/**
 * Shutdown: stop this process's end-of-alarm timers but keep active alarms
 * persisted, so the next process restores them (restoreActiveAlarms).
 */
export function suspendActiveAlarms(): void {
  for (const a of active().values()) clearTimeout(a.timer)
  active().clear()
}
