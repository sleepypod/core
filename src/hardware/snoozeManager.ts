/**
 * Manages alarm snooze timeouts per side.
 * Snooze = clear alarm immediately, re-trigger after duration expires.
 */
import { getSharedHardwareClient } from './dacMonitor.instance'
import type { Side } from './types'

interface SnoozeState {
  timeoutId: ReturnType<typeof setTimeout>
  snoozeUntil: Date
  config: { vibrationIntensity: number, vibrationPattern: 'double' | 'rise', duration: number }
}

const activeSnoozes = new Map<Side, SnoozeState>()

export function snoozeAlarm(
  side: Side,
  durationSeconds: number,
  config: SnoozeState['config'],
): Date {
  // Cancel any existing snooze for this side
  cancelSnooze(side)

  const snoozeUntil = new Date(Date.now() + durationSeconds * 1000)

  const timeoutId = setTimeout(async () => {
    activeSnoozes.delete(side)
    try {
      const client = getSharedHardwareClient()
      await client.setAlarm(side, config)
      const { broadcastMutationStatus } = await import('@/src/streaming/broadcastMutationStatus')
      broadcastMutationStatus(side, { isAlarmVibrating: true })
    }
    catch (err) {
      console.error(`[Snooze] Failed to restart alarm for ${side}:`, err)
    }
  }, durationSeconds * 1000)

  activeSnoozes.set(side, { timeoutId, snoozeUntil, config })
  return snoozeUntil
}

export function cancelSnooze(side: Side): void {
  const existing = activeSnoozes.get(side)
  if (existing) {
    clearTimeout(existing.timeoutId)
    activeSnoozes.delete(side)
  }
}

export function getSnoozeStatus(side: Side): { active: boolean, snoozeUntil: number | null } {
  const state = activeSnoozes.get(side)
  return {
    active: !!state,
    snoozeUntil: state ? Math.floor(state.snoozeUntil.getTime() / 1000) : null,
  }
}
