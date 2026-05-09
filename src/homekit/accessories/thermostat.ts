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
 * - TargetTemperature → setTemperature
 * - TargetHeatingCoolingState toggles power: 0=off, 3=auto (pod is bidirectional)
 * - CurrentHeatingCoolingState reflects the live drive direction
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
      const f = clampF(c2f(Number(value)))
      await getSharedHardwareClient().setTemperature(side, f)
    })

  // Lock to off / auto. HEAT and COOL are removed because the pod's auto
  // controller decides direction internally — exposing them would let iOS
  // pick a mode the firmware doesn't act on.
  service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [TARGET_OFF, TARGET_AUTO] })
    .onGet(() => isPowered(monitor, side) ? TARGET_AUTO : TARGET_OFF)
    .onSet(async (value) => {
      const client = getSharedHardwareClient()
      if (Number(value) === TARGET_OFF) {
        await client.setPower(side, false)
      }
      else {
        // setPower(side, true) without a temperature falls back to 75°F in
        // the hardware client, which would silently overwrite the user's
        // last setpoint on every HomeKit power-on. Pass the live target so
        // power cycles preserve intent.
        await client.setPower(side, true, readLastTargetF(monitor, side))
      }
    })

  service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .onGet(() => deriveCurrentState(monitor, side))

  // Pod is locked to Celsius natively (HAP requires C semantics; iOS converts
  // for display per the controller setting). Drop PAIRED_WRITE so iOS doesn't
  // render a writable C/F toggle that silently bounces back on the next read.
  service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .setProps({ perms: ['pr', 'ev'] as never })
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

// Exported so powerSwitch.ts can reuse the same definition rather than
// drift on its own copy.
export function isPoweredFromStatus(status: DeviceStatus, side: Side): boolean {
  const s = side === 'left' ? status.leftSide : status.rightSide
  return s.targetLevel !== 0
}

// Last known target setpoint in °F. Falls back to NEUTRAL when no status
// has been observed yet so a power-on without a prior poll lands on a
// safe-ish temp instead of the client's hardcoded 75°F default.
export function readLastTargetF(monitor: DacMonitor, side: Side): number {
  const status = monitor.getLastStatus()
  if (!status) return c2f(NEUTRAL_C)
  const s = side === 'left' ? status.leftSide : status.rightSide
  return s.targetTemperature
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
