import { describe, expect, it } from 'vitest'
import {
  THERMAL_PANELS, availabilityOf, hourTicks, liveToPoints, nearestPoint, panelDomain, seriesPath, type HistoryPoint,
} from '../thermalHistoryLogic'

const empty: Omit<HistoryPoint, 't'> = {
  leftBed: null, rightBed: null, leftTarget: null, rightTarget: null, leftWater: null, rightWater: null,
  leftSurface: null, rightSurface: null, leftRpm: null, rightRpm: null, heatsink: null, ambient: null,
}
const pt = (t: number, over: Partial<HistoryPoint> = {}): HistoryPoint => ({ t, ...empty, ...over })
const panel = (id: string) => {
  const found = THERMAL_PANELS.find(p => p.id === id)
  if (!found) throw new Error(`no panel ${id}`)
  return found
}

describe('panelDomain', () => {
  it('pads temperatures to round ticks', () => {
    const d = panelDomain(panel('bedTarget'), [pt(0, { leftBed: 72.4, leftTarget: 80 }), pt(1, { rightBed: 78.5 })])
    expect(d).toEqual({ min: 68, max: 84, ticks: [68, 72, 76, 80, 84] })
  })
  it('starts pump speed at zero', () => {
    expect(panelDomain(panel('pump'), [pt(0, { leftRpm: 2207 })])).toEqual({ min: 0, max: 3000, ticks: [0, 1500, 3000] })
  })
  it('converts before picking ticks and is null with no data', () => {
    const d = panelDomain(panel('water'), [pt(0, { leftWater: 80 })], f => (f - 32) * 5 / 9)
    expect(d?.min).toBeLessThan(26.7)
    expect(d?.max).toBeGreaterThan(26.7)
    expect(panelDomain(panel('hub'), [pt(0)])).toBeNull()
  })
})

describe('seriesPath', () => {
  const d = { min: 0, max: 100, ticks: [] }
  it('breaks the line across gaps and nulls', () => {
    const pts = [pt(0, { leftRpm: 0 }), pt(10, { leftRpm: 50 }), pt(100, { leftRpm: 100 }), pt(110), pt(120, { leftRpm: 0 })]
    expect(seriesPath(pts, 'leftRpm', 0, 120, 120, d, 20)).toBe('M0.0,100.00L10.0,50.00M100.0,0.00M120.0,100.00')
  })
})

describe('nearestPoint / hourTicks', () => {
  it('picks the closest sample', () => {
    expect(nearestPoint([pt(0), pt(10), pt(20)], 14)?.t).toBe(10)
    expect(nearestPoint([], 1)).toBeNull()
  })
  it('keeps ticks inside the window and at most ~6', () => {
    const from = new Date('2026-09-28T06:10:00').getTime()
    const to = from + 12 * 3_600_000
    const ticks = hourTicks(from, to)
    expect(ticks.length).toBeLessThanOrEqual(6)
    expect(ticks.every(t => t >= from && t <= to)).toBe(true)
    expect(new Date(ticks[0]).getMinutes()).toBe(0)
  })
})

describe('liveToPoints', () => {
  it('maps the 5 s snapshot buffer and hides bed/target on an off side', () => {
    const [p] = liveToPoints([{
      t: 5,
      heatsinkTempF: 75.6,
      ambientTempF: 76.6,
      sides: [
        { side: 'left', isPowered: true, targetTempF: 80, currentTempF: 80.1, waterTempF: 78.7, bedSurfaceTempF: 78.9, pumpRpm: 1947 },
        { side: 'right', isPowered: false, targetTempF: 83, currentTempF: 83, waterTempF: 72, bedSurfaceTempF: 72, pumpRpm: 0 },
      ],
    }])
    expect(p).toMatchObject({ leftBed: 80.1, leftTarget: 80, rightBed: null, rightTarget: null, rightRpm: 0, heatsink: 75.6 })
    expect(availabilityOf([p])).toEqual({ bedTarget: true, water: true, surface: true, pump: true, hub: true })
  })
})
