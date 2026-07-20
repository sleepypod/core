import { describe, it, expect } from 'vitest'
import {
  generateSleepCurve,
  curveToScheduleTemperatures,
  curvePointToDisplayTime,
  timeStringToMinutes,
  minutesToTimeStr,
} from './generate'
import type { CurvePoint } from './types'

describe('generateSleepCurve', () => {
  it('pins every phase transition for an eight-hour balanced curve', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 6 * 60,
      intensity: 'balanced',
      minTempF: 69,
      maxTempF: 87,
    })

    expect(points.map(point => [point.minutesFromBedtime, point.tempOffset, point.phase])).toEqual([
      [-45, 0, 'warmUp'],
      [-30, 1, 'warmUp'],
      [-15, 1, 'warmUp'],
      [0, 2, 'warmUp'],
      [18, 1, 'coolDown'],
      [36, -3, 'coolDown'],
      [54, -5, 'coolDown'],
      [72, -7, 'coolDown'],
      [96, -9, 'deepSleep'],
      [120, -11, 'deepSleep'],
      [165, -11, 'deepSleep'],
      [210, -11, 'deepSleep'],
      [225, -9, 'maintain'],
      [240, -8, 'maintain'],
      [255, -6, 'maintain'],
      [345, -6, 'maintain'],
      [435, -6, 'maintain'],
      [450, -2, 'preWake'],
      [465, 3, 'preWake'],
      [480, 7, 'preWake'],
      [490, 5, 'wake'],
      [500, 2, 'wake'],
      [510, 0, 'wake'],
    ])
  })

  it('pins the compressed transition arithmetic for a short curve', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 30,
      intensity: 'cool',
      minTempF: 69,
      maxTempF: 87,
    })

    expect(points.map(point => [point.minutesFromBedtime, point.tempOffset, point.phase])).toEqual([
      [-45, 0, 'warmUp'], [-30, 0, 'warmUp'], [-15, 1, 'warmUp'], [0, 1, 'warmUp'],
      [6, 1, 'coolDown'], [11, -4, 'coolDown'], [17, -6, 'coolDown'], [23, -8, 'coolDown'],
      [30, -9, 'deepSleep'], [38, -11, 'deepSleep'], [53, -11, 'deepSleep'], [68, -11, 'deepSleep'],
      [83, -10, 'maintain'], [98, -8, 'maintain'], [113, -7, 'maintain'], [143, -7, 'maintain'],
      [145, -2, 'preWake'], [148, 2, 'preWake'], [150, 7, 'preWake'],
      [160, 5, 'wake'], [170, 2, 'wake'], [180, 0, 'wake'],
    ])
  })

  it('treats equal bedtime and wake time as a full twenty-four-hour window', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 7 * 60,
      wakeMinutes: 7 * 60,
      intensity: 'warm',
      minTempF: 69,
      maxTempF: 87,
    })

    expect(points.findLast(point => point.phase === 'preWake')?.minutesFromBedtime).toBe(1440)
    expect(points.at(-1)?.minutesFromBedtime).toBe(1470)
  })

  it('generates sorted points for a typical 8-hour sleep', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60, // 10 PM
      wakeMinutes: 6 * 60, // 6 AM
    })

    expect(points.length).toBeGreaterThan(15)

    // Should be sorted by time
    for (let i = 1; i < points.length; i++) {
      expect(points[i].minutesFromBedtime).toBeGreaterThanOrEqual(points[i - 1].minutesFromBedtime)
    }
  })

  it('starts before bedtime (wind down) and ends after wake', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 6 * 60,
    })

    // First point should be before bedtime (negative offset)
    expect(points[0].minutesFromBedtime).toBeLessThan(0)

    // Sleep duration is 8h = 480min. Last point should be after that
    expect(points[points.length - 1].minutesFromBedtime).toBeGreaterThan(480)
  })

  it('reaches minimum temperature during deep sleep', () => {
    const minTemp = 68
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 6 * 60,
      minTempF: minTemp,
      maxTempF: 86,
    })

    const deepSleepPoints = points.filter(p => p.phase === 'deepSleep')
    expect(deepSleepPoints.length).toBeGreaterThan(0)

    // Deep sleep should hit the full cool range (80 - 68 = -12)
    const minOffset = Math.min(...deepSleepPoints.map(p => p.tempOffset))
    expect(minOffset).toBe(-(80 - minTemp))
  })

  it('reaches maximum temperature during pre-wake', () => {
    const maxTemp = 86
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 6 * 60,
      minTempF: 68,
      maxTempF: maxTemp,
    })

    const preWakePoints = points.filter(p => p.phase === 'preWake')
    expect(preWakePoints.length).toBeGreaterThan(0)

    // Pre-wake should hit the full warm range (86 - 80 = 6)
    const maxOffset = Math.max(...preWakePoints.map(p => p.tempOffset))
    expect(maxOffset).toBe(maxTemp - 80)
  })

  it('handles overnight wrap (bedtime after midnight handled)', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 23 * 60, // 11 PM
      wakeMinutes: 7 * 60, // 7 AM
    })

    expect(points.length).toBeGreaterThan(15)
    expect(points[0].minutesFromBedtime).toBeLessThan(0)
  })

  it('cool intensity produces more aggressive cooling', () => {
    const opts = { bedtimeMinutes: 22 * 60, wakeMinutes: 6 * 60, minTempF: 68, maxTempF: 86 }
    const cool = generateSleepCurve({ ...opts, intensity: 'cool' as const })
    const warm = generateSleepCurve({ ...opts, intensity: 'warm' as const })

    // Cool should have lower fall-asleep temps than warm
    const coolFallAsleep = cool.filter(p => p.phase === 'coolDown')
    const warmFallAsleep = warm.filter(p => p.phase === 'coolDown')

    const coolMin = Math.min(...coolFallAsleep.map(p => p.tempOffset))
    const warmMin = Math.min(...warmFallAsleep.map(p => p.tempOffset))
    expect(coolMin).toBeLessThan(warmMin)
  })

  it('returns to neutral (offset 0) at end of wake phase', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 6 * 60,
    })

    const lastPoint = points[points.length - 1]
    expect(lastPoint.phase).toBe('wake')
    expect(lastPoint.tempOffset).toBe(0)
  })

  it('all phases are represented', () => {
    const points = generateSleepCurve({
      bedtimeMinutes: 22 * 60,
      wakeMinutes: 6 * 60,
    })

    const phases = new Set(points.map(p => p.phase))
    expect(phases.has('warmUp')).toBe(true)
    expect(phases.has('coolDown')).toBe(true)
    expect(phases.has('deepSleep')).toBe(true)
    expect(phases.has('maintain')).toBe(true)
    expect(phases.has('preWake')).toBe(true)
    expect(phases.has('wake')).toBe(true)
  })

  it('produces monotonic, non-overlapping phases for short sleep (< 218 min)', () => {
    // Regression for #327: for sleepDuration ≈ 150 min the original algorithm
    // emitted maintain-phase points after preWake started, causing legend/chart
    // rendering to be incorrect after sorting.
    for (const duration of [150, 180, 200, 217, 240]) {
      const bedtimeMinutes = 22 * 60
      const wakeMinutes = (bedtimeMinutes + duration) % (24 * 60)
      const points = generateSleepCurve({ bedtimeMinutes, wakeMinutes })

      // 1. Points must be sorted by time
      for (let i = 1; i < points.length; i++) {
        expect(points[i].minutesFromBedtime).toBeGreaterThanOrEqual(points[i - 1].minutesFromBedtime)
      }

      // 2. Phases must appear in canonical order without interleaving
      const phaseOrder: Record<string, number> = {
        warmUp: 0, coolDown: 1, deepSleep: 2, maintain: 3, preWake: 4, wake: 5,
      }
      let lastPhaseOrder = -1
      for (const p of points) {
        const order = phaseOrder[p.phase]
        expect(order).toBeGreaterThanOrEqual(lastPhaseOrder)
        lastPhaseOrder = order
      }

      // 3. All phases still present
      const phases = new Set(points.map(p => p.phase))
      expect(phases.has('warmUp')).toBe(true)
      expect(phases.has('coolDown')).toBe(true)
      expect(phases.has('deepSleep')).toBe(true)
      expect(phases.has('maintain')).toBe(true)
      expect(phases.has('preWake')).toBe(true)
      expect(phases.has('wake')).toBe(true)
    }
  })
})

describe('curveToScheduleTemperatures', () => {
  it('converts curve points to HH:mm → tempF map', () => {
    const points: CurvePoint[] = [
      { minutesFromBedtime: 0, tempOffset: 2, phase: 'warmUp' },
      { minutesFromBedtime: 60, tempOffset: -4, phase: 'coolDown' },
    ]

    const result = curveToScheduleTemperatures(points, 22 * 60)
    expect(result['22:00']).toBe(82)
    expect(result['23:00']).toBe(76)
  })

  it('handles overnight wrap correctly', () => {
    const points: CurvePoint[] = [
      { minutesFromBedtime: 120, tempOffset: -6, phase: 'deepSleep' },
    ]

    // Bedtime 23:00 + 120 min = 01:00
    const result = curveToScheduleTemperatures(points, 23 * 60)
    expect(result['01:00']).toBe(74)
  })
})

describe('time utility functions', () => {
  it('timeStringToMinutes converts correctly', () => {
    expect(timeStringToMinutes('00:00')).toBe(0)
    expect(timeStringToMinutes('12:30')).toBe(750)
    expect(timeStringToMinutes('22:00')).toBe(1320)
    expect(timeStringToMinutes('23:59')).toBe(1439)
  })

  it('minutesToTimeStr converts correctly', () => {
    expect(minutesToTimeStr(0)).toBe('00:00')
    expect(minutesToTimeStr(750)).toBe('12:30')
    expect(minutesToTimeStr(1320)).toBe('22:00')
    // Handle > 1440
    expect(minutesToTimeStr(1500)).toBe('01:00')
    // Handle negative
    expect(minutesToTimeStr(-60)).toBe('23:00')
  })

  it('curvePointToDisplayTime formats 12h correctly', () => {
    expect(curvePointToDisplayTime(0, 22 * 60)).toBe('10:00 PM')
    expect(curvePointToDisplayTime(120, 22 * 60)).toBe('12:00 AM')
    expect(curvePointToDisplayTime(480, 22 * 60)).toBe('6:00 AM')
    expect(curvePointToDisplayTime(0, 12 * 60)).toBe('12:00 PM')
  })
})
