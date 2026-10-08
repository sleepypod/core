import { describe, expect, it } from 'vitest'
import type { BedTempFrame, BedTemp2Frame } from '@/src/hooks/useSensorStream'
import { latestThermalReading, THERMAL_RAMP, thermalColor, thermalState } from '../thermalData'

const frame: BedTempFrame = {
  type: 'bedTemp', ts: 100, ambientTemp: 23, mcuTemp: null, humidity: null,
  leftOuterTemp: 20, leftCenterTemp: 22, leftInnerTemp: 24,
  rightOuterTemp: 30, rightCenterTemp: 28, rightInnerTemp: 26,
}
const control = { currentTemperature: 80, targetTemperature: 70, targetLevel: -5 }

describe('thermal surface data', () => {
  it('selects the freshest transport instead of pinning a stale newer-generation frame', () => {
    const newer: BedTemp2Frame = { ...frame, type: 'bedTemp2', ts: 90 }
    expect(latestThermalReading(frame, newer)?.ts).toBe(100)
    expect(latestThermalReading(frame, newer, { leftOuterTemp: 20, leftCenterTemp: 22, leftInnerTemp: 24, rightOuterTemp: 30, rightCenterTemp: 28, rightInnerTemp: 26, timestamp: new Date(110_000) })?.source).toBe('stored')
    expect(latestThermalReading(frame, { ...newer, ts: 120 })?.source).toBe('live')
  })
  it('preserves side and outer/center/inner ordering, missing sensors, and Celsius', () => {
    expect(latestThermalReading(frame)).toMatchObject({ left: [20, 22, 24], right: [30, 28, 26] })
    expect(latestThermalReading({ ...frame, leftOuterTemp: NaN, leftCenterTemp: null, leftInnerTemp: Infinity })?.left).toEqual([null, null, null])
    expect(latestThermalReading()).toBeNull()
  })
  it('uses the controller current and target to indicate requested direction', () => {
    expect(thermalState([30, 31, 32], control, false)).toMatchObject({ direction: -1, strength: 1, mode: 'cooling', targetF: 70, currentF: 80 })
    // Any active side gets at least half strength; the gap to target adds the rest.
    expect(thermalState([20, 21, 22], { ...control, targetTemperature: 84 }, false)).toMatchObject({ direction: 1, strength: 0.75, mode: 'heating' })
    expect(thermalState([20, 21, 22], { ...control, targetTemperature: 80.5 }, false)).toMatchObject({ direction: 0, strength: 0, mode: 'holding' })
  })
  it('stops bands for off, blocked, stale, unknown and invalid controller readings', () => {
    for (const c of [undefined, { ...control, targetLevel: 0 }, { ...control, currentTemperature: null }, { ...control, targetTemperature: NaN }]) {
      expect(thermalState([20, 22, 24], c, false).direction).toBe(0)
    }
    expect(thermalState([20, 22, 24], control, false, true).direction).toBe(0)
    // Stale sensors blank the field but never the pod's own status.
    expect(thermalState([20, 22, 24], control, true)).toEqual({ zones: [null, null, null], direction: 0, strength: 0, mode: 'cooling', targetF: 70, currentF: 80 })
  })
  it('names what the pod is doing from the controller alone', () => {
    expect(thermalState([20, 22, 24], undefined, false)).toMatchObject({ mode: 'unavailable', targetF: null, currentF: null })
    expect(thermalState([20, 22, 24], { ...control, targetLevel: 0 }, false)).toMatchObject({ mode: 'off', targetF: null, currentF: 80 })
    expect(thermalState([20, 22, 24], control, false, true)).toMatchObject({ mode: 'paused', targetF: 70 })
    expect(thermalState([20, 22, 24], { ...control, currentTemperature: null }, false)).toMatchObject({ mode: 'waiting', targetF: 70, currentF: null })
    expect(thermalState([20, 22, 24], { ...control, targetTemperature: NaN }, false)).toMatchObject({ mode: 'waiting', targetF: null })
  })
  it('uses a fixed color scale, clamped endpoints and neutral missing readings', () => {
    expect(thermalColor(18)).toBe(THERMAL_RAMP.dark[0])
    expect(thermalColor(27)).toBe(THERMAL_RAMP.dark[2])
    expect(thermalColor(36, 'light')).toBe(THERMAL_RAMP.light[4])
    expect(thermalColor(36)).toBe(THERMAL_RAMP.dark[4])
    expect(thermalColor(-10)).toBe(thermalColor(18))
    expect(thermalColor(50)).toBe(thermalColor(36))
    expect(thermalColor(null)).toBe(THERMAL_RAMP.dark[2])
  })
})
