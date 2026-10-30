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
 * - CurrentHeatingCoolingState reflects the reported current level mode
 *
 * All hardware writes go through sideController so concurrent characteristic
 * onSet callbacks don't race each other and stomp the user's setpoint.
 *
 * HomeKit talks Celsius natively; we convert at the boundary.
 */

import { Service, Characteristic, HapStatusError } from 'hap-nodejs'
import type { Perms } from 'hap-nodejs'
import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { Side } from '@/src/hardware/types'
import { MAX_LEVEL, MAX_TEMP, MIN_LEVEL, MIN_TEMP } from '@/src/hardware/types'
import { getRequestedTargetF, setSidePowerOff, setSidePowerOn, setTargetTemperature } from './sideController'
import { registerServiceFault } from './serviceFaults'
import { freshThermostatReport } from './reportedState'
export { THERMOSTAT_FRESH_MS } from './reportedState'

const fahrenheitToCelsius = (value: number): number => ((value - 32) * 5) / 9
const MIN_C = fahrenheitToCelsius(MIN_TEMP)
const MAX_C = fahrenheitToCelsius(MAX_TEMP)
const TARGET_OFF = 0, TARGET_AUTO = 3
const CURRENT_OFF = 0, CURRENT_HEAT = 1, CURRENT_COOL = 2

export interface ThermostatAccessory { service: Service, stop: () => void }
interface Readings { current: number | null, target: number | null, requestedMode: number | null, currentMode: number | null }

function validLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_LEVEL && value <= MAX_LEVEL
}
function temperature(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= MIN_TEMP && value <= MAX_TEMP ? fahrenheitToCelsius(value) : null
}

/** Current mode is derived from the reported current level, not the requested level or physical heat-flow measurement. */
function readThermostatState(monitor: DacMonitor, side: Side): Readings {
  const missing: Readings = { current: null, target: null, requestedMode: null, currentMode: null }
  try {
    const observation = freshThermostatReport(monitor)
    if (!observation) return missing
    const reported = observation.status[side === 'left' ? 'leftSide' : 'rightSide']
    // A target explicitly staged while OFF is a request. No neutral/default value becomes a measurement.
    const requested = reported.targetLevel === 0 ? getRequestedTargetF(side) ?? reported.targetTemperature : reported.targetTemperature
    return {
      current: temperature(reported.currentTemperature), target: temperature(requested),
      requestedMode: validLevel(reported.targetLevel) ? reported.targetLevel === 0 ? TARGET_OFF : TARGET_AUTO : null,
      currentMode: validLevel(reported.currentLevel) ? reported.currentLevel === 0 ? CURRENT_OFF : reported.currentLevel > 0 ? CURRENT_HEAT : CURRENT_COOL : null,
    }
  }
  catch { return missing }
}

function available(value: number | null): number {
  if (value === null) throw new HapStatusError(-70402)
  return value
}

export function buildThermostatService(side: Side, monitor: DacMonitor): ThermostatAccessory {
  const service = new Service.Thermostat(`Bed ${side}`, side)
  const current = service.getCharacteristic(Characteristic.CurrentTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => available(readThermostatState(monitor, side).current))
  const target = service.getCharacteristic(Characteristic.TargetTemperature)
    .setProps({ minValue: MIN_C, maxValue: MAX_C, minStep: 0.5 })
    .onGet(() => available(readThermostatState(monitor, side).target))
    .onSet(async (value) => {
      try {
        await setTargetTemperature(monitor, side, (Number(value) * 9) / 5 + 32)
      }
      finally { refresh() }
    })
  const requestedMode = service.getCharacteristic(Characteristic.TargetHeatingCoolingState)
    .setProps({ validValues: [TARGET_OFF, TARGET_AUTO] })
    .onGet(() => available(readThermostatState(monitor, side).requestedMode))
    .onSet(async (value) => {
      try {
        if (Number(value) === TARGET_OFF) await setSidePowerOff(monitor, side)
        else await setSidePowerOn(monitor, side)
      }
      finally { refresh() }
    })
  const currentMode = service.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
    .onGet(() => available(readThermostatState(monitor, side).currentMode))
  service.getCharacteristic(Characteristic.TemperatureDisplayUnits)
    .setProps({ perms: ['pr', 'ev'] as Perms[] }).onGet(() => 0)
  const fault = registerServiceFault(service, () => Object.values(readThermostatState(monitor, side)).some(value => value === null))
  let stopped = false

  // Ignore event payloads: delayed polls and intervening writes must pass the monitor's freshness/revision fence.
  function refresh() {
    if (stopped) return
    const observation = readThermostatState(monitor, side)
    for (const [characteristic, value] of [[current, observation.current], [target, observation.target],
      [requestedMode, observation.requestedMode], [currentMode, observation.currentMode]] as const) {
      characteristic.updateValue(value === null ? new HapStatusError(-70402) : value)
    }
    fault.refresh()
  }
  refresh()
  monitor.on('status:updated', refresh)
  monitor.on('connection:lost', refresh)
  const timer = setInterval(refresh, 1000)
  timer.unref?.()
  return { service, stop() {
    stopped = true
    clearInterval(timer)
    monitor.off('status:updated', refresh)
    monitor.off('connection:lost', refresh)
    fault.stop()
  } }
}
