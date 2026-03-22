/**
 * Broadcast a deviceStatus frame after a mutation (temperature, power, alarm).
 *
 * Overlays the mutation onto the last polled status from DacMonitor so all
 * WS clients see the change immediately. Fire-and-forget — never blocks the
 * caller. DacMonitor's 2s poll remains the authoritative consistency backstop.
 *
 * Used by both the device router (user-initiated mutations) and the scheduler
 * (automated jobs) so all writers go through the same broadcast path.
 */

import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { broadcastFrame } from './piezoStream'
import { getPrimeCompletedAt } from '@/src/hardware/primeNotification'
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
