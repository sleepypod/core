/**
 * SleepCurve generation algorithm — ported from iOS SleepCurve.swift
 *
 * Generates a science-backed temperature curve from bedtime and wake time.
 *
 * References:
 * - Heller 2012: warming before bed dilates blood vessels, accelerates core heat loss
 * - Kräuchi 2007: core body temp drop of 1-2°F triggers sleep onset
 * - Czeisler 1999: rising body temp 30min before wake triggers natural waking
 * - Walker 2017: sleep quality correlates with thermal environment
 */

import type {
  CoolingIntensity,
  CurvePoint,
  PhaseRatios,
  ScheduleTemperatures,
} from './types'

const BASE_TEMP_F = 80

/** Ratios: how much of available range each transition phase uses */
const INTENSITY_RATIOS: Record<CoolingIntensity, PhaseRatios> = {
  cool: { warmUp: 0.2, fallAsleep: 0.7, maintain: 0.6 },
  balanced: { warmUp: 0.3, fallAsleep: 0.6, maintain: 0.5 },
  warm: { warmUp: 0.5, fallAsleep: 0.4, maintain: 0.3 },
}

export interface GenerateOptions {
  /** Bedtime in minutes from midnight (e.g. 22:00 = 1320) */
  bedtimeMinutes: number
  /** Wake time in minutes from midnight (e.g. 7:00 = 420) */
  wakeMinutes: number
  /** Cooling intensity preset */
  intensity?: CoolingIntensity
  /** Minimum temperature in °F (default 68) */
  minTempF?: number
  /** Maximum temperature in °F (default 86) */
  maxTempF?: number
}

/**
 * Generate a temperature curve from bedtime to wake time.
 * Returns sorted points with ~15 minute intervals.
 *
 * All times are expressed as minutesFromBedtime (negative = before bed).
 */
export function generateSleepCurve(options: GenerateOptions): CurvePoint[] {
  const {
    bedtimeMinutes,
    wakeMinutes,
    intensity = 'balanced',
    minTempF = 68,
    maxTempF = 86,
  } = options

  // Calculate sleep duration in minutes, handling overnight wrap
  let sleepDuration = wakeMinutes - bedtimeMinutes
  if (sleepDuration <= 0) sleepDuration += 24 * 60

  const ratios = INTENSITY_RATIOS[intensity]

  // Map intensity ratios to the user's actual temp range
  const coolRange = BASE_TEMP_F - minTempF // e.g. 80-70 = 10
  const warmRange = maxTempF - BASE_TEMP_F // e.g. 86-80 = 6

  const offsets = {
    warmUp: Math.round(warmRange * ratios.warmUp),
    fallAsleep: -Math.round(coolRange * ratios.fallAsleep),
    deepSleep: -coolRange, // always hits min
    maintain: -Math.round(coolRange * ratios.maintain),
    preWake: warmRange, // always hits max
  }

  const points: CurvePoint[] = []

  // Water takes ~15-20 min to change 1°F in the tubing.
  // All transitions are gradual — no sharp steps.

  // ── Wind Down: bedtime -45min → bedtime (gentle warm) ──
  points.push({ minutesFromBedtime: -45, tempOffset: 0, phase: 'warmUp' })
  points.push({ minutesFromBedtime: -30, tempOffset: Math.round(offsets.warmUp / 3), phase: 'warmUp' })
  points.push({ minutesFromBedtime: -15, tempOffset: Math.round(offsets.warmUp * 2 / 3), phase: 'warmUp' })
  points.push({ minutesFromBedtime: 0, tempOffset: offsets.warmUp, phase: 'warmUp' })

  // ── Fall Asleep: bedtime → +coolRamp (slow cool ramp) ──
  const coolRampMin = Math.min(90, sleepDuration * 0.15)
  points.push({ minutesFromBedtime: Math.round(coolRampMin * 0.25), tempOffset: Math.round(offsets.warmUp / 2), phase: 'coolDown' })
  points.push({ minutesFromBedtime: Math.round(coolRampMin * 0.5), tempOffset: Math.round(offsets.fallAsleep / 2), phase: 'coolDown' })
  points.push({ minutesFromBedtime: Math.round(coolRampMin * 0.75), tempOffset: Math.round(offsets.fallAsleep * 3 / 4), phase: 'coolDown' })
  points.push({ minutesFromBedtime: Math.round(coolRampMin), tempOffset: offsets.fallAsleep, phase: 'coolDown' })

  // ── Transition to deep: another 30-60min to reach coldest ──
  const deepTransitionMin = Math.min(60, sleepDuration * 0.1)
  const deepStartMin = coolRampMin + deepTransitionMin
  points.push({
    minutesFromBedtime: Math.round(coolRampMin + deepTransitionMin * 0.5),
    tempOffset: Math.round((offsets.fallAsleep + offsets.deepSleep) / 2),
    phase: 'deepSleep',
  })
  points.push({ minutesFromBedtime: Math.round(deepStartMin), tempOffset: offsets.deepSleep, phase: 'deepSleep' })

  // ── Deep Sleep: hold coldest for ~2-3h ──
  const deepSleepEndMin = Math.min(3.5 * 60, sleepDuration * 0.45)
  const deepMidMin = (deepStartMin + deepSleepEndMin) / 2
  points.push({ minutesFromBedtime: Math.round(deepMidMin), tempOffset: offsets.deepSleep, phase: 'deepSleep' })
  points.push({ minutesFromBedtime: Math.round(deepSleepEndMin), tempOffset: offsets.deepSleep, phase: 'deepSleep' })

  // ── Gradual rise to maintain: ~45min transition ──
  const maintainStartMin = deepSleepEndMin + 45
  const dsMaintainDiff = offsets.maintain - offsets.deepSleep
  points.push({
    minutesFromBedtime: Math.round(deepSleepEndMin + 15),
    tempOffset: Math.round(offsets.deepSleep + dsMaintainDiff / 3),
    phase: 'maintain',
  })
  points.push({
    minutesFromBedtime: Math.round(deepSleepEndMin + 30),
    tempOffset: Math.round(offsets.deepSleep + dsMaintainDiff * 2 / 3),
    phase: 'maintain',
  })
  points.push({ minutesFromBedtime: Math.round(maintainStartMin), tempOffset: offsets.maintain, phase: 'maintain' })

  // ── Maintain: flat hold ──
  const preWakeStartMin = sleepDuration - 45
  if (preWakeStartMin > maintainStartMin + 30) {
    const mid = (maintainStartMin + preWakeStartMin) / 2
    points.push({ minutesFromBedtime: Math.round(mid), tempOffset: offsets.maintain, phase: 'maintain' })
  }
  points.push({ minutesFromBedtime: Math.round(preWakeStartMin), tempOffset: offsets.maintain, phase: 'maintain' })

  // ── Pre-Wake: gradual warm over 45min ──
  const pwMaintainDiff = offsets.preWake - offsets.maintain
  points.push({
    minutesFromBedtime: Math.round(preWakeStartMin + 15),
    tempOffset: Math.round(offsets.maintain + pwMaintainDiff / 3),
    phase: 'preWake',
  })
  points.push({
    minutesFromBedtime: Math.round(preWakeStartMin + 30),
    tempOffset: Math.round(offsets.maintain + pwMaintainDiff * 2 / 3),
    phase: 'preWake',
  })
  points.push({ minutesFromBedtime: sleepDuration, tempOffset: offsets.preWake, phase: 'preWake' })

  // ── Wake: slow return to neutral over 30min ──
  points.push({
    minutesFromBedtime: sleepDuration + 10,
    tempOffset: Math.round(offsets.preWake * 2 / 3),
    phase: 'wake',
  })
  points.push({
    minutesFromBedtime: sleepDuration + 20,
    tempOffset: Math.round(offsets.preWake / 3),
    phase: 'wake',
  })
  points.push({ minutesFromBedtime: sleepDuration + 30, tempOffset: 0, phase: 'wake' })

  return points.sort((a, b) => a.minutesFromBedtime - b.minutesFromBedtime)
}

/**
 * Convert a bedtime minutes-from-midnight + offset → an actual HH:mm string.
 */
function minutesToTimeString(bedtimeMinutes: number, offsetMinutes: number): string {
  let totalMin = bedtimeMinutes + offsetMinutes
  // Normalize to 0–1440 range
  totalMin = ((totalMin % 1440) + 1440) % 1440
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Convert curve points to schedule set points (HH:mm → tempF pairs).
 * If multiple points share the same HH:mm timestamp, the last one wins.
 */
export function curveToScheduleTemperatures(
  points: CurvePoint[],
  bedtimeMinutes: number,
  baseTempF: number = BASE_TEMP_F,
): ScheduleTemperatures {
  const result: ScheduleTemperatures = {}
  for (const point of points) {
    const key = minutesToTimeString(bedtimeMinutes, point.minutesFromBedtime)
    result[key] = baseTempF + point.tempOffset
  }
  return result
}

/**
 * Convert minutesFromBedtime to a display time string (e.g. "10:30 PM").
 */
export function curvePointToDisplayTime(
  minutesFromBedtime: number,
  bedtimeMinutes: number,
): string {
  let totalMin = bedtimeMinutes + minutesFromBedtime
  totalMin = ((totalMin % 1440) + 1440) % 1440
  const h = totalMin / 60 | 0
  const m = totalMin % 60
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

/**
 * Parse an HH:mm time string to minutes from midnight.
 */
export function timeStringToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number)
  return h * 60 + m
}

/**
 * Convert minutes from midnight to HH:mm string.
 */
export function minutesToTimeStr(minutes: number): string {
  const normalized = ((minutes % 1440) + 1440) % 1440
  const h = Math.floor(normalized / 60)
  const m = normalized % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
