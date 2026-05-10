/**
 * HomeKit Switch that mirrors and controls a Pod side's power state.
 *
 * Sits alongside the Thermostat for the same side. The Thermostat's mode
 * already toggles power, but a dedicated Switch gives users a tappable tile
 * (and an automation/scene primitive) that doesn't require entering the
 * thermostat card. Both surfaces resolve through sideController so the
 * writes are serialized and share the in-process target cache.
 */

import { Service, Characteristic } from 'hap-nodejs'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import {
  isCurrentlyPowered,
  isPoweredFromStatus,
  setSidePowerOff,
  setSidePowerOn,
} from './sideController'

export interface PowerSwitchAccessory {
  service: Service
  stop: () => void
}

export function buildPowerSwitch(side: Side, monitor: DacMonitor): PowerSwitchAccessory {
  const service = new Service.Switch(`Bed ${side} power`, `power-${side}`)

  service.getCharacteristic(Characteristic.On)
    .onGet(() => isCurrentlyPowered(monitor, side))
    .onSet(async (value) => {
      if (value) await setSidePowerOn(monitor, side)
      else await setSidePowerOff(monitor, side)
    })

  const onStatus = (status: DeviceStatus): void => {
    service.updateCharacteristic(Characteristic.On, isPoweredFromStatus(status, side))
  }
  monitor.on('status:updated', onStatus)

  return {
    service,
    stop: () => {
      monitor.off('status:updated', onStatus)
    },
  }
}
