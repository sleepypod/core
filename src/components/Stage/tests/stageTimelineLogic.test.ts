import { describe, expect, it } from 'vitest'
import { HOUR, clock, fractionOf, formatUntil, hourLabel, nextChange, scheduledAt, sideActivity, stageCurves, stageRange, stageTicks, stageWindow, timeAtFraction } from '../stageTimelineLogic'

// Monday 28 Sep 2026, 9 PM local.
const now = new Date(2026, 8, 28, 21, 0)
const rows = (day: string, points: [string, number][]) => points.map(([time, temperature]) => ({ dayOfWeek: day, time, temperature, enabled: true }))

describe('tonight window', () => {
  it('runs from 6 PM to 9 AM around tonight, flipping to the next night at 9 AM', () => {
    const win = stageWindow(now)
    expect(new Date(win.start).getHours()).toBe(18)
    expect(win.end - win.start).toBe(15 * HOUR)
    expect(win.midnight.getDate()).toBe(28)
    const morning = stageWindow(new Date(2026, 8, 29, 7, 0))
    expect(morning.midnight.getDate()).toBe(28)
    const later = stageWindow(new Date(2026, 8, 29, 9, 30))
    expect(later.midnight.getDate()).toBe(29)
  })
  it('ticks every three hours and maps fractions both ways', () => {
    const win = stageWindow(now)
    expect(stageTicks(win)).toHaveLength(6)
    expect(fractionOf(win, now.getTime())).toBeCloseTo(3 / 15)
    expect(fractionOf(win, win.start - HOUR)).toBe(0)
    expect(new Date(timeAtFraction(win, 0.5)).getHours()).toBe(1)
    expect(new Date(timeAtFraction(win, 0.5)).getMinutes()).toBe(30)
    expect(timeAtFraction(win, 2)).toBe(win.end)
  })
})

describe('curves and preview', () => {
  const win = stageWindow(now)
  const curves = stageCurves({
    left: rows('monday', [['22:00', 72], ['02:00', 68], ['06:00', 79]]),
    right: rows('monday', [['23:00', 84], ['05:30', 80]]),
  }, win)
  it('places both nights on absolute time and shares one range', () => {
    expect(curves.left).toHaveLength(3)
    expect(new Date(curves.left[1].at).getDate()).toBe(29)
    expect(stageRange(curves)).toEqual({ lo: 67, hi: 85 })
    expect(stageRange(stageCurves({ left: undefined, right: undefined }, win))).toBeNull()
  })
  it('reads what the schedule holds at a moment, or off outside it', () => {
    const at = (h: number, m = 0) => new Date(2026, 8, h >= 18 ? 28 : 29, h, m).getTime()
    expect(scheduledAt(curves, 'left', at(22, 30))).toBe(72)
    expect(scheduledAt(curves, 'left', at(3))).toBe(68)
    expect(scheduledAt(curves, 'left', at(6))).toBe(79)
    expect(scheduledAt(curves, 'left', at(20))).toBeNull()
    expect(scheduledAt(curves, 'right', at(0))).toBe(84)
  })
  it('names the soonest set point on either side and formats the wait', () => {
    expect(nextChange(curves, now.getTime())).toEqual({ side: 'left', at: curves.left[0].at, temperatureF: 72 })
    expect(nextChange(curves, new Date(2026, 8, 28, 22, 30).getTime())).toMatchObject({ side: 'right', temperatureF: 84 })
    expect(nextChange(curves, new Date(2026, 8, 29, 8).getTime())).toBeNull()
    expect(formatUntil(2 * HOUR + 8 * 60_000)).toBe('2h 08m')
    expect(formatUntil(45 * 60_000)).toBe('45m')
    expect(formatUntil(-5)).toBe('0m')
  })
})

describe('side activity', () => {
  const win = stageWindow(now)
  const curve = stageCurves({ left: rows('monday', [['22:00', 84], ['06:00', 84]]), right: [] }, win).left
  const at = (day: number, h: number, min = 0) => new Date(2026, 8, day, h, min).getTime()

  it('clips powered stretches to the window and reads the side\'s own target column', () => {
    const history = { bucketSec: 300, points: [
      { t: at(28, 12), leftTarget: 70, rightTarget: null },
      { t: at(28, 18, 1), leftTarget: 70, rightTarget: null },
      { t: at(28, 19), leftTarget: null, rightTarget: 75 },
    ] }
    const left = sideActivity({ curve, records: undefined, history, side: 'left', win, now: now.getTime() })
    expect(left.power).toEqual([{ start: win.start, end: at(28, 18, 1) + 150_000 }])
    const right = sideActivity({ curve: [], records: undefined, history, side: 'right', win, now: now.getTime() })
    expect(right.power).toEqual([{ start: at(28, 19) - 150_000, end: at(28, 19) + 150_000 }])
  })

  it('ends the powered stretch at now instead of half a bucket past it', () => {
    const history = { bucketSec: 300, points: [{ t: now.getTime(), leftTarget: 70, rightTarget: null }] }
    expect(sideActivity({ curve, records: undefined, history, side: 'left', win, now: now.getTime() }).power)
      .toEqual([{ start: now.getTime() - 150_000, end: now.getTime() }])
  })

  it('labels a warming schedule running on an empty bed and drops nothing when the bed matches', () => {
    const late = [{ enteredBedAt: new Date(at(28, 23)), leftBedAt: new Date(at(29, 6)), presentIntervals: [] }]
    expect(sideActivity({ curve, records: late, history: undefined, side: 'left', win, now: now.getTime() }).mismatches)
      .toEqual([{ start: at(28, 22), end: at(28, 23), label: 'bed empty while warming · 1h 0m' }])
    const onTime = [{ enteredBedAt: new Date(at(28, 22)), leftBedAt: new Date(at(29, 6)), presentIntervals: [] }]
    expect(sideActivity({ curve, records: onTime, history: undefined, side: 'left', win, now: now.getTime() }).mismatches).toEqual([])
  })
})

describe('clock labels', () => {
  it('follow the pod time format, keeping midnight at 00:00 in 24-hour mode', () => {
    const late = new Date(2026, 8, 28, 23, 30).getTime()
    const midnight = new Date(2026, 8, 29, 0, 0).getTime()
    expect(clock(late)).toBe('11:30 PM')
    expect(clock(late, '24h')).toBe('23:30')
    expect(hourLabel(midnight)).toBe('12 AM')
    expect(hourLabel(midnight, '24h')).toBe('00:00')
  })
})
