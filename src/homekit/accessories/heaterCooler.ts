/**
 * HomeKit HeaterCooler accessory bound to one Pod side.
 *
 * - Active toggle → device.setPower(side, on/off)
 * - HeatingThresholdTemperature / CoolingThresholdTemperature → setTemperature
 * - CurrentTemperature reflects DacMonitor status updates within poll cycle
 *
 * HomeKit talks Celsius natively; we convert at the boundary.
 */

import { Service, Characteristic } from 'hap-nodejs'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import { MAX_TEMP, MIN_TEMP } from '@/src/hardware/types'
import { getSharedHardwareClient } from '@/src/hardware/dacMonitor.instance'

const f2c = (f: number): number => ((f - 32) * 5) / 9
const c2f = (c: number): number => (c * 9) / 5 + 32

const MIN_C = f2c(MIN_TEMP)
const MAX_C = f2c(MAX_TEMP)
const NEUTRAL_C = f2c(82.5)

export interface HeaterCoolerAccessory {
  service: Service
  stop: () => void
}

export function buildHeaterCoolerService(side: Side, monitor: DacMonitor): HeaterCoolerAccessory {
  const service = new Service.HeaterCooler(`Bed ${side}`, side)

  service.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => readCurrentC(monitor, side))

  service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => readTargetC(monitor, side))
    .onSet(async (value) => {
      const f = clampF(c2f(Number(value)))
      await getSharedHardwareClient().setTemperature(side, f)
    })

  service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => readTargetC(monitor, side))
    .onSet(async (value) => {
      const f = clampF(c2f(Number(value)))
      await getSharedHardwareClient().setTemperature(side, f)
    })

  service.getCharacteristic(Characteristic.Active)
    .onGet(() => isPowered(monitor, side) ? 1 : 0)
    .onSet(async (value) => {
      const on = Number(value) === 1
      await getSharedHardwareClient().setPower(side, on)
    })

  // 0=auto, 1=heat, 2=cool — pod is bidirectional; map both to AUTO target.
  service.getCharacteristic(Characteristic.TargetHeaterCoolerState)
    .setProps({ validValues: [0] })
    .onGet(() => 0)

  service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
    .onGet(() => deriveCurrentState(monitor, side))

  service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .onGet(() => 0) // 0=C, 1=F — HAP requires C semantics regardless

  const onStatus = (status: DeviceStatus): void => {
    service.updateCharacteristic(Characteristic.CurrentTemperature, sideC(status, side, 'current'))
    service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, sideC(status, side, 'target'))
    service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, sideC(status, side, 'target'))
    service.updateCharacteristic(Characteristic.Active, isPoweredFromStatus(status, side) ? 1 : 0)
    service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, deriveStateFromStatus(status, side))
  }
  monitor.on('status:updated', onStatus)

  return {
    service,
    stop: () => {
      monitor.off('status:updated', onStatus)
    },
  }
}

function clampF(f: number): number {
  return Math.min(MAX_TEMP, Math.max(MIN_TEMP, f))
}

function readCurrentC(monitor: DacMonitor, side: Side): number {
  const status = monitor.getLastStatus()
  return status ? sideC(status, side, 'current') : NEUTRAL_C
}

function readTargetC(monitor: DacMonitor, side: Side): number {
  const status = monitor.getLastStatus()
  return status ? sideC(status, side, 'target') : NEUTRAL_C
}

function sideC(status: DeviceStatus, side: Side, kind: 'current' | 'target'): number {
  const s = side === 'left' ? status.leftSide : status.rightSide
  const f = kind === 'current' ? s.currentTemperature : s.targetTemperature
  return f2c(f)
}

function isPowered(monitor: DacMonitor, side: Side): boolean {
  const status = monitor.getLastStatus()
  return status ? isPoweredFromStatus(status, side) : false
}

function isPoweredFromStatus(status: DeviceStatus, side: Side): boolean {
  const s = side === 'left' ? status.leftSide : status.rightSide
  return s.targetLevel !== 0
}

function deriveCurrentState(monitor: DacMonitor, side: Side): number {
  const status = monitor.getLastStatus()
  return status ? deriveStateFromStatus(status, side) : 0
}

function deriveStateFromStatus(status: DeviceStatus, side: Side): number {
  const s = side === 'left' ? status.leftSide : status.rightSide
  // 0=inactive, 1=idle, 2=heating, 3=cooling
  if (s.targetLevel === 0) return 0
  if (s.targetLevel > s.currentLevel) return 2
  if (s.targetLevel < s.currentLevel) return 3
  return 1
}
