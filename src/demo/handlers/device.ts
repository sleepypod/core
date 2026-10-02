import type { DemoHandlers, RouterOutputs } from '../types'
import { MINUTE, toCelsius } from '../util'

type Side = 'left' | 'right'
type Status = RouterOutputs['device']['getStatus']
type ControlStatus = RouterOutputs['device']['resumeTemperature']

const NEUTRAL_F = 82.5
const RANGE_F = 27.5
// Water temperature closes ~63% of the gap to target every 6 minutes.
const RAMP_TAU_MS = 6 * MINUTE

interface SideState {
  powered: boolean
  targetF: number
  /** Temperature when the current target was set; the ramp eases from here. */
  fromF: number
  setAt: number
  holdUntil: number | null
  source: ControlStatus['source']
  alarmVibrating: boolean
  snoozeUntil: number | null
}

const now = () => Date.now()

const sides: Record<Side, SideState> = {
  left: { powered: true, targetF: 68, fromF: 74, setAt: now() - 20 * MINUTE, holdUntil: null, source: 'schedule', alarmVibrating: false, snoozeUntil: null },
  right: { powered: true, targetF: 78, fromF: 72, setAt: now() - 12 * MINUTE, holdUntil: null, source: 'schedule', alarmVibrating: false, snoozeUntil: null },
}

let isPriming = false
let primeStartedAt: number | null = null
let primeCompletedAt: number | null = null

function currentF(s: SideState): number {
  const t = now() - s.setAt
  const f = s.targetF + (s.fromF - s.targetF) * Math.exp(-t / RAMP_TAU_MS)
  return Math.round(f * 10) / 10
}

const toLevel = (f: number) => Math.max(-100, Math.min(100, Math.round(((f - NEUTRAL_F) / RANGE_F) * 100)))

function setTarget(side: Side, targetF: number, source: ControlStatus['source'], holdUntil: number | null) {
  const s = sides[side]
  s.fromF = s.powered ? currentF(s) : NEUTRAL_F
  s.setAt = now()
  s.targetF = targetF
  s.powered = true
  s.source = source
  s.holdUntil = holdUntil
}

function controlStatus(side: Side): ControlStatus {
  const s = sides[side]
  return {
    source: s.powered ? s.source : null,
    requestId: null,
    targetTemperature: s.powered ? s.targetF : null,
    holdUntil: s.holdUntil,
    blocked: s.powered ? null : 'off',
  }
}

function sideStatus(side: Side, unit: 'F' | 'C') {
  const s = sides[side]
  const conv = (f: number) => (unit === 'C' ? toCelsius(f) : f)
  const cur = s.powered ? currentF(s) : null
  return {
    currentTemperature: cur === null ? null : conv(cur),
    targetTemperature: s.powered ? conv(s.targetF) : null,
    currentLevel: cur === null ? 0 : toLevel(cur),
    targetLevel: s.powered ? toLevel(s.targetF) : 0,
    heatingDuration: s.powered ? 8 * 3600 : 0,
    isAlarmVibrating: s.alarmVibrating,
  }
}

function snooze(side: Side) {
  const until = sides[side].snoozeUntil
  const active = until !== null && until > now()
  return { active, snoozeUntil: active ? Math.floor(until / 1000) : null }
}

/** Shared with the fake sensor socket so `deviceStatus` frames match tRPC. */
export function getDemoDeviceStatus(unit: 'F' | 'C' = 'F'): Status {
  if (isPriming && primeCompletedAt === null) {
    // Priming in the demo takes 20 s instead of several minutes.
    if (now() - (primeStartedAt ?? 0) > 20_000) {
      isPriming = false
      primeCompletedAt = now()
    }
  }
  return {
    temperatureControl: { left: controlStatus('left'), right: controlStatus('right') },
    leftSide: sideStatus('left', unit),
    rightSide: sideStatus('right', unit),
    waterLevel: 'ok',
    isPriming,
    podVersion: 'J00',
    sensorLabel: 'demo-pod',
    gestures: { doubleTap: { l: 1, r: 1 }, tripleTap: { l: 1, r: 1 } },
    ...(primeCompletedAt !== null && { primeCompletedNotification: { timestamp: Math.floor(primeCompletedAt / 1000) } }),
    pumpStallNotifications: { left: null, right: null },
    snooze: { left: snooze('left'), right: snooze('right') },
    wifiStrength: 78,
    wifiSSID: 'Demo Wi-Fi',
    roomClimate: { temperatureC: 21.4, humidity: 44, timestamp: Math.floor(now() / 1000) },
    waterLevelRaw: { raw: 812, calibratedEmpty: 400, calibratedFull: 900, timestamp: Math.floor(now() / 1000) },
  }
}

export const device: DemoHandlers<'device'> = {
  getStatus: input => getDemoDeviceStatus(input.unit),

  getTemperatureControl: input => controlStatus(input.side),

  setTemperature: (input) => {
    const holdUntil = input.holdMinutes === undefined ? null : now() + input.holdMinutes * MINUTE
    setTarget(input.side, input.temperature, 'manual', holdUntil)
    return { success: true }
  },

  resumeTemperature: (input) => {
    sides[input.side].holdUntil = null
    sides[input.side].source = 'schedule'
    return controlStatus(input.side)
  },

  setPower: (input) => {
    const s = sides[input.side]
    if (input.powered) {
      setTarget(input.side, input.temperature ?? s.targetF, 'manual', null)
    }
    else {
      s.powered = false
      s.holdUntil = null
    }
    return { success: true }
  },

  setAlarm: (input) => {
    sides[input.side].alarmVibrating = true
    return { success: true }
  },

  clearAlarm: (input) => {
    sides[input.side].alarmVibrating = false
    sides[input.side].snoozeUntil = null
    return { success: true }
  },

  snoozeAlarm: (input) => {
    const snoozeUntil = Math.floor(now() / 1000) + (input.duration ?? 300)
    sides[input.side].alarmVibrating = false
    sides[input.side].snoozeUntil = snoozeUntil * 1000
    return { success: true, snoozeUntil }
  },

  startPriming: () => {
    isPriming = true
    primeStartedAt = now()
    primeCompletedAt = null
    return { success: true }
  },

  dismissPrimeNotification: () => {
    primeCompletedAt = null
    return { success: true }
  },
}
