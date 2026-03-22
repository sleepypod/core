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
  })
})
