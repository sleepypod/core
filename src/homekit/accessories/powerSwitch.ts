/**
 * HomeKit Switch that mirrors and controls a Pod side's power state.
 *
 * Sits alongside the Thermostat for the same side. The Thermostat's mode
 * already toggles power, but a dedicated Switch gives users a tappable tile
 * (and an automation/scene primitive) that doesn't require entering the
 * thermostat card. Both surfaces resolve to the same setPower(side) call.
 */

import { Service, Characteristic } from 'hap-nodejs'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'
import { isPoweredFromStatus, readLastTargetF } from './thermostat'

export interface PowerSwitchAccessory {
  service: Service
  stop: () => void
}

export function buildPowerSwitch(side: Side, monitor: DacMonitor): PowerSwitchAccessory {
  const service = new Service.Switch(`Bed ${side} power`, `power-${side}`)

  service.getCharacteristic(Characteristic.On)
    .onGet(() => isPowered(monitor, side))
    .onSet(async (value) => {
      const client = getSharedHardwareClient()
      if (value) {
        // setPower(side, true) without a temperature falls back to 75°F.
        // Preserve the user's last setpoint across power cycles instead.
        await client.setPower(side, true, readLastTargetF(monitor, side))
      }
      else {
        await client.setPower(side, false)
      }
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

function isPowered(monitor: DacMonitor, side: Side): boolean {
  const status = monitor.getLastStatus()
  return status ? isPoweredFromStatus(status, side) : false
}
