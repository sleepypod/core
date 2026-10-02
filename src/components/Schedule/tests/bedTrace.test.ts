import { describe, expect, it } from 'vitest'
import type { ThermalHistoryPoint } from '@/src/lib/thermalHistory'
import { bedTrace, lastNightLabel, lastNightMidnight, lastNightRange } from '../bedTrace'

const midnight = new Date(2026, 8, 28)
const at = (h: number, m = 0) => new Date(2026, 8, 28, h, m).getTime()
const point = (t: number, over: Partial<ThermalHistoryPoint> = {}): ThermalHistoryPoint => ({
  t, leftBed: null, rightBed: null, leftTarget: null, rightTarget: null, leftWater: null, rightWater: null,
  leftSurface: null, rightSurface: null, leftRpm: null, rightRpm: null, heatsink: null, ambient: null, ...over,
})

describe('bedTrace', () => {
  it('maps bed readings to minutes after the night-start midnight, past 24h for the morning', () => {
    const points = [
      point(at(22, 30), { leftBed: 79, rightBed: 80 }),
      point(at(26, 0), { leftBed: 78.5, rightBed: null }),
      point(at(27, 0)),
    ]
    expect(bedTrace(points, 'left', midnight)).toEqual([
      { minutes: 22 * 60 + 30, temperature: 79 },
      { minutes: 26 * 60, temperature: 78.5 },
    ])
    expect(bedTrace(points, 'right', midnight)).toEqual([{ minutes: 22 * 60 + 30, temperature: 80 }])
  })

  it('applies the lane offset for curves drawn a day earlier', () => {
    const points = [point(at(26, 0), { leftBed: 78 })]
    expect(bedTrace(points, 'left', midnight, -24 * 60)).toEqual([{ minutes: 2 * 60, temperature: 78 }])
  })

  it('falls back to the surface sensor before thermal_state has history', () => {
    const points = [point(at(23, 0), { leftSurface: 77.2 }), point(at(23, 4), { leftSurface: null })]
    expect(bedTrace(points, 'left', midnight)).toEqual([{ minutes: 23 * 60, temperature: 77.2 }])
    expect(bedTrace([], 'left', midnight)).toEqual([])
    expect(bedTrace(undefined, 'left', midnight)).toEqual([])
  })
})

describe('last night', () => {
  it('starts yesterday whether the night is still running or long over', () => {
    expect(lastNightMidnight(new Date(2026, 8, 29, 2, 30))).toEqual(midnight)
    expect(lastNightMidnight(new Date(2026, 8, 29, 15))).toEqual(midnight)
    expect(lastNightMidnight(new Date(2026, 9, 1, 15))).toEqual(new Date(2026, 8, 30))
  })

  it('is "tonight" before 9 AM and needs 48 h of history once evening comes', () => {
    expect(lastNightLabel(new Date(2026, 8, 29, 2))).toBe('tonight')
    expect(lastNightLabel(new Date(2026, 8, 29, 9))).toBe('last night')
    expect(lastNightRange(new Date(2026, 8, 29, 9))).toBe('24h')
    expect(lastNightRange(new Date(2026, 8, 29, 18))).toBe('48h')
  })
})
