/**
 * Broadcast a deviceStatus frame after a mutation (temperature, power, alarm).
 *
 * Overlays the mutation onto the last polled status from DacMonitor so all
 * WS clients see the change immediately. Fire-and-forget — never blocks the
 * caller. DacMonitor's adaptive poll (1–5s) remains the authoritative
 * consistency backstop.
 *
 * Called by the device/runOnce routers, scheduler jobs, snooze manager,
 * automation engine, and auto-off watcher. Not every writer broadcasts —
 * HomeKit and gesture writes rely on the poll to surface their changes.
 */

import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { broadcastFrame } from './piezoStream'
import { getPrimeCompletedAt } from '@/src/hardware/primeNotification'
import { getAllPumpStallNotices } from '@/src/hardware/pumpStallNotification'
import { getAlarmState } from '@/src/hardware/deviceStateSync'
import { getSnoozeStatus } from '@/src/hardware/snoozeManager'

export function broadcastMutationStatus(
  side?: 'left' | 'right',
  sideOverlay?: Record<string, unknown>,
): void {
  try {
    const monitor = getDacMonitorIfRunning()
    const lastStatus = monitor?.getLastStatus()
    if (!lastStatus) return

    const primeCompletedAt = getPrimeCompletedAt()
    const alarmState = getAlarmState()
    const stallNotices = getAllPumpStallNotices()
    const leftSide = { ...lastStatus.leftSide, isAlarmVibrating: alarmState.left }
    const rightSide = { ...lastStatus.rightSide, isAlarmVibrating: alarmState.right }

    if (side && sideOverlay) {
      if (side === 'left') Object.assign(leftSide, sideOverlay)
      else Object.assign(rightSide, sideOverlay)
    }

    broadcastFrame({
      type: 'deviceStatus',
      ts: Date.now(),
      leftSide,
      rightSide,
      waterLevel: lastStatus.waterLevel,
      isPriming: lastStatus.isPriming,
      ...(primeCompletedAt && { primeCompletedNotification: { timestamp: primeCompletedAt } }),
      ...((stallNotices.left || stallNotices.right) && { pumpStallNotifications: stallNotices }),
      snooze: {
        left: getSnoozeStatus('left'),
        right: getSnoozeStatus('right'),
      },
    })
  }
  catch (e) {
    console.warn('[broadcastMutationStatus]', e)
  }
}
