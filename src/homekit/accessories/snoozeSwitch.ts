/**
 * HomeKit Switch that snoozes (on) or cancels snooze (off) a side's alarm.
 * Snooze duration mirrors the iOS default (9 minutes) at neutral pattern.
 */

import { Service, Characteristic } from 'hap-nodejs'
import {
  cancelSnooze,
  getSnoozeStatus,
  snoozeAlarm,
} from '@/src/hardware/snoozeManager'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { getActiveAlarmConfig, markAlarmEnded } from '@/src/hardware/alarmState'
import type { Side } from '@/src/hardware/types'

const SNOOZE_SECONDS = 9 * 60
const POLL_MS = 5_000

export interface SnoozeSwitchAccessory {
  service: Service
  stop: () => void
}

export function buildSnoozeSwitch(side: Side): SnoozeSwitchAccessory {
  const service = new Service.Switch(`Snooze ${side}`, `snooze-${side}`)

  const setOn = (on: boolean): void => {
    service.updateCharacteristic(Characteristic.On, on)
  }

  service.getCharacteristic(Characteristic.On)
    .onGet(() => getSnoozeStatus(side).active)
    .onSet(async (value) => {
      const on = Number(value) === 1
      if (on) {
        // Pull alarm-vibration off the bed and re-fire after the window,
        // as it was (or gently, if no alarm of ours is vibrating).
        const config = getActiveAlarmConfig(side) ?? { vibrationIntensity: 50, vibrationPattern: 'rise' as const, duration: 60 }
        try {
          await getSharedHardwareClient().clearAlarm(side)
        }
        catch (e) {
          console.warn(`[homekit] clearAlarm(${side}) failed during snooze:`, e instanceof Error ? e.message : e)
        }
        snoozeAlarm(side, SNOOZE_SECONDS, config)
        await markAlarmEnded(side)
      }
      else {
        cancelSnooze(side)
      }
    })

  const handle = setInterval(() => {
    setOn(getSnoozeStatus(side).active)
  }, POLL_MS)
  handle.unref?.()

  return {
    service,
    stop: () => clearInterval(handle),
  }
}
