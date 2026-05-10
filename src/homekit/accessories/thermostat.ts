/**
 * HomeKit Thermostat accessory bound to one Pod side.
 *
 * Why Thermostat instead of HeaterCooler: pod hardware exposes a single
 * setpoint, not a heat/cool deadband. HeaterCooler in AUTO mode forces iOS
 * to render two thresholds, and because both onSet handlers wrote the same
 * unified target, every adjustment collapsed the visible range to a point —
 * iOS would fight decreases as deadband-violating. Thermostat is HomeKit's
 * single-setpoint primitive, which matches the pod 1:1.
 *
 * - TargetTemperature → setTargetTemperature (cached, gated on power)
 * - TargetHeatingCoolingState toggles power: 0=off, 3=auto (pod is bidirectional)
 * - CurrentHeatingCoolingState reflects the live drive direction
 *
 * All hardware writes go through sideController so concurrent characteristic
 * onSet callbacks don't race each other and stomp the user's setpoint.
 *
 * HomeKit talks Celsius natively; we convert at the boundary.
 */

import { Service, Characteristic } from 'hap-nodejs'
import type { Perms } from 'hap-nodejs'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus, Side } from '@/src/hardware/types'
import { MAX_TEMP, MIN_TEMP } from '@/src/hardware/types'
import {
  isCurrentlyPowered,
  isPoweredFromStatus,
  setSidePowerOff,
  setSidePowerOn,
  setTargetTemperature,
} from './sideController'

const f2c = (f: number): number => ((f - 32) * 5) / 9

const MIN_C = f2c(MIN_TEMP)
const MAX_C = f2c(MAX_TEMP)
const NEUTRAL_C = f2c(82.5)

const TARGET_OFF = 0
const TARGET_AUTO = 3
const CURRENT_OFF = 0
const CURRENT_HEAT = 1
const CURRENT_COOL = 2

export interface ThermostatAccessory {
  service: Service
  stop: () => void
}

export function buildThermostatService(side: Side, monitor: DacMonitor): ThermostatAccessory {
  const service = new Service.Thermostat(`Bed ${side}`, side)

  service.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => readCurrentC(monitor, side))

  service.getCharacteristic(Characteristic.TargetTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => readTargetC(monitor, side))
    .onSet(async (value) => {
      const f = (Number(value) * 9) / 5 + 32
      await setTargetTemperature(monitor, side, f)
    })

  // Lock to off / auto. HEAT and COOL are removed because the pod's auto
  // controller decides direction internally — exposing them would let iOS
  // pick a mode the firmware doesn't act on.
  service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [TARGET_OFF, TARGET_AUTO] })
    .onGet(() => isCurrentlyPowered(monitor, side) ? TARGET_AUTO : TARGET_OFF)
    .onSet(async (value) => {
      if (Number(value) === TARGET_OFF) await setSidePowerOff(monitor, side)
      else await setSidePowerOn(monitor, side)
    })

  service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .onGet(() => deriveCurrentState(monitor, side))

  // Pod is locked to Celsius natively (HAP requires C semantics; iOS converts
  // for display per the controller setting). Drop PAIRED_WRITE so iOS doesn't
  // render a writable C/F toggle that silently bounces back on the next read.
  service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .setProps({ perms: ['pr', 'ev'] as Perms[] })
    .onGet(() => 0)

  const onStatus = (status: DeviceStatus): void => {
    service.updateCharacteristic(Characteristic.CurrentTemperature, sideC(status, side, 'current'))
    service.updateCharacteristic(Characteristic.TargetTemperature, sideC(status, side, 'target'))
    service.updateCharacteristic(
      Characteristic.TargetHeatingCoolingState,
      isPoweredFromStatus(status, side) ? TARGET_AUTO : TARGET_OFF,
    )
    service.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, deriveStateFromStatus(status, side))
  }
  monitor.on('status:updated', onStatus)

  return {
    service,
    stop: () => {
      monitor.off('status:updated', onStatus)
    },
  }
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

function deriveCurrentState(monitor: DacMonitor, side: Side): number {
  const status = monitor.getLastStatus()
  return status ? deriveStateFromStatus(status, side) : CURRENT_OFF
}

function deriveStateFromStatus(status: DeviceStatus, side: Side): number {
  const s = side === 'left' ? status.leftSide : status.rightSide
  // targetLevel is signed: positive = driving warmer, negative = driving cooler,
  // zero = idle/off. Thermostat has no idle state — collapse to OFF.
  if (s.targetLevel === 0) return CURRENT_OFF
  return s.targetLevel > 0 ? CURRENT_HEAT : CURRENT_COOL
}
