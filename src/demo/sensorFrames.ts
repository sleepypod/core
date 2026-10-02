import { getDemoDeviceStatus } from './handlers/device'
import { randomBetween, toCelsius } from './util'

export const ALL_SENSORS = ['piezo-dual', 'capSense', 'capSense2', 'bedTemp', 'bedTemp2', 'frzTemp', 'frzTherm', 'frzHealth', 'log', 'deviceStatus', 'gesture', 'lps']
const PIEZO_HZ = 500
const NO_SENSOR = -327.68

const LOG_LINES = [
  'sensor_timing.cpp:88 updateRefMarker|[sensor] drift 1ms',
  'Thermal.cpp:212 control|[therm] left pid ok',
  'Thermal.cpp:212 control|[therm] right pid ok',
  'Pump.cpp:141 tick|[pump] flow nominal',
  'Capwater.cpp:57 sample|[cap] water level ok',
  'Piezo.cpp:301 stream|[piezo] frame ok',
]

export const nowSec = () => Math.floor(Date.now() / 1000)

/** Bed-contact BCG trace: breathing swell plus a sharp J-wave per heartbeat. */
function piezoChannel(startSec: number, baseline: number, bpm: number, brpm: number, seed: number): number[] {
  const samples: number[] = []
  const beat = 60 / bpm
  for (let i = 0; i < PIEZO_HZ; i++) {
    const t = startSec + i / PIEZO_HZ
    const phase = (t % beat) / beat
    const jWave = Math.exp(-((phase - 0.3) ** 2) / 0.0012) * 9000 - Math.exp(-((phase - 0.38) ** 2) / 0.002) * 4000
    const breath = Math.sin(2 * Math.PI * t * brpm / 60 + seed) * 7000
    samples.push(Math.round(baseline + jWave + breath + (Math.random() - 0.5) * 600))
  }
  return samples
}

export function piezoFrame(ts: number) {
  return {
    type: 'piezo-dual', ts, freq: PIEZO_HZ,
    left1: piezoChannel(ts, -400_000, 58, 14, 0),
    right1: piezoChannel(ts, -395_000, 64, 16, 1.7),
  }
}

export function bedTempFrame(ts: number) {
  const status = getDemoDeviceStatus('F')
  // Surface temps sit a little closer to the room than the water does.
  const surface = (f: number | null) => toCelsius(((f ?? 80) * 0.7) + (76 * 0.3))
  const zones = (f: number | null) => [0, 0.3, -0.2, NO_SENSOR].map(d => d === NO_SENSOR ? d : surface(f) + d + randomBetween(Math.random, -0.05, 0.05))
  return {
    type: 'bedTemp2', ts, version: 1, mcu: 33.8,
    left: { amb: 21.4, hu: 44.2, board: 29.5, temps: zones(status.leftSide.currentTemperature) },
    right: { amb: NO_SENSOR, hu: NO_SENSOR, board: 28.3, temps: zones(status.rightSide.currentTemperature) },
  }
}

export function capSenseFrame(ts: number) {
  const jitter = (v: number) => v + randomBetween(Math.random, -0.04, 0.04)
  return {
    type: 'capSense2', ts, version: 1,
    left: { values: [17.15, 17.12, 17.21, 17.2, 21.6, 21.6, 1.16, 1.16].map(jitter), status: 'good' },
    right: { values: [16.06, 16.04, 15.93, 15.92, 22.46, 22.46, 1.17, 1.17].map(jitter), status: 'good' },
  }
}

export function freezerFrames(ts: number) {
  const status = getDemoDeviceStatus('F')
  const sideFrz = (s: typeof status.leftSide) => {
    const cooling = s.targetTemperature !== null && s.currentTemperature !== null && s.targetTemperature < s.currentTemperature
    const active = s.targetTemperature !== null
    return {
      tec: { current: active ? (cooling ? 11.2 : 6.4) + randomBetween(Math.random, -0.3, 0.3) : 0 },
      pump: { mode: 'pwm', rpm: active ? Math.round(2400 + randomBetween(Math.random, -40, 40)) : 0, water: true, duty: active ? 62 : 0 },
      temps: { flowrate: active ? 28.7 + randomBetween(Math.random, -0.4, 0.4) : 0 },
    }
  }
  const therm = (s: typeof status.leftSide) => ({
    target: s.targetTemperature === null ? 27 : toCelsius(s.targetTemperature),
    power: s.targetTemperature === null ? 0 : 45,
    valid: true,
    enabled: s.targetTemperature !== null,
  })
  const waterC = (f: number | null) => Math.round(toCelsius(f ?? 78) * 100)
  return [
    { type: 'frzTemp', ts, left: waterC(status.leftSide.currentTemperature), right: waterC(status.rightSide.currentTemperature), amb: 2140, hs: 2530 },
    { type: 'frzTherm', ts, version: 1, left: therm(status.leftSide), right: therm(status.rightSide) },
    { type: 'frzHealth', ts, version: 1, left: sideFrz(status.leftSide), right: sideFrz(status.rightSide), fan: { top: { rpm: Math.round(randomBetween(Math.random, 1100, 1250)) }, bottom: { rpm: 0 } } },
  ]
}

export function deviceStatusFrame() {
  return { type: 'deviceStatus', ts: Date.now(), ...getDemoDeviceStatus('F') }
}

export function logFrame(ts: number) {
  const msg = LOG_LINES[Math.floor(Math.random() * LOG_LINES.length)]
  return { type: 'log', ts, level: 'debug', msg: `${(ts % 100_000_000).toString().padStart(8, '0')} ${msg}` }
}

export function snapshotMessage() {
  const ts = nowSec()
  return {
    type: 'snapshot',
    latest: [bedTempFrame(ts), capSenseFrame(ts), ...freezerFrames(ts), logFrame(ts), deviceStatusFrame()],
    waveform: Array.from({ length: 10 }, (_, i) => piezoFrame(ts - 10 + i)),
    range: { min: ts - 6 * 3600, max: ts },
  }
}
