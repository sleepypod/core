/**
 * One alarm ringing on both sides. With a single sleeper their alarm also
 * vibrates the other side (they may have rolled onto it): each side's
 * AlarmConfig names the other as `linkedSide`, so stopping or snoozing either
 * stops both, and a snoozed alarm comes back on both.
 */
import type { HardwareClient } from './client'
import { getActiveAlarmConfig, markAlarmEnded, markAlarmStarted } from './alarmState'
import { withSideLock } from './sideLock'
import { isSameLinkedAlarm, type AlarmConfig } from './alarmPersistence'
import type { Side } from './types'

/**
 * Ring the side linked to an alarm that just started on `side`. Callers hold
 * the linked side's lock.
 */
export async function ringLinked(client: Pick<HardwareClient, 'setAlarm'>, side: Side, config: AlarmConfig): Promise<void> {
  const linked = config.linkedSide
  if (!linked || linked === side) return
  const partner = { ...config, linkedSide: side }
  try {
    await client.setAlarm(linked, partner)
    await markAlarmStarted(linked, partner)
  }
  catch (error) {
    console.error(`[linkedAlarm] failed to ring ${linked} with ${side}:`, error)
  }
}

/**
 * Stop the side linked to the alarm on `side`, which was just stopped or
 * snoozed and already marked ended. Runs under the linked side's lock, so a
 * partner start waiting for it sees the stop and skips. A different alarm
 * now ringing there is left alone. A failed clear leaves the side marked
 * ringing so another Stop can retry, and returns false so the caller can
 * report it.
 */
export async function stopLinked(client: Pick<HardwareClient, 'clearAlarm'>, side: Side, config: AlarmConfig | null | undefined): Promise<boolean> {
  const linked = config?.linkedSide
  if (!config || !linked || linked === side) return true
  return withSideLock(linked, async () => {
    const current = getActiveAlarmConfig(linked)
    if (current && !isSameLinkedAlarm(current, side, config)) return true
    try {
      await client.clearAlarm(linked)
    }
    catch (error) {
      console.error(`[linkedAlarm] failed to stop ${linked} with ${side}:`, error)
      return false
    }
    await markAlarmEnded(linked)
    return true
  })
}
