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

export interface PowerSwitchAccessory {
  service: Service
  stop: () => void
}

export function buildPowerSwitch(side: Side, monitor: DacMonitor): PowerSwitchAccessory {
  const service = new Service.Switch(`Bed ${side} power`, `power-${side}`)

  service.getCharacteristic(Characteristic.On)
    .onGet(() => isPowered(monitor, side))
    .onSet(async (value) => {
      await getSharedHardwareClient().setPower(side, Boolean(value))
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

function isPoweredFromStatus(status: DeviceStatus, side: Side): boolean {
  const s = side === 'left' ? status.leftSide : status.rightSide
  return s.targetLevel !== 0
}
