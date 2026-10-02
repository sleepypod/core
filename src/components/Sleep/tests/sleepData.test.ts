import { describe, expect, it } from 'vitest'
import {
  averageClock,
  buildNights,
  dayKey,
  downsample,
  formatDuration,
  formatRange,
  groupByNight,
  heatAlpha,
  hypnoTicks,
  mainRecord,
  monthCells,
  monthWeeks,
  nightKey,
  nightWindow,
  sleepSplit,
  stageDurations,
  toHypnoBlocks,
  toWeekNights,
} from '../sleepData'

const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m)
const rec = (id: number, entered: Date, hours: number, exits = 0) => ({
  id,
  enteredBedAt: entered,
  leftBedAt: new Date(entered.getTime() + hours * 3_600_000),
  sleepDurationSeconds: hours * 3600,
  timesExitedBed: exits,
})

describe('night grouping', () => {
  it('assigns sessions starting before 6 AM to the previous night', () => {
    expect(nightKey(at(27, 23, 20))).toBe('2026-09-27')
    expect(nightKey(at(28, 0, 30))).toBe('2026-09-27')
    expect(nightKey(at(28, 5, 59))).toBe('2026-09-27')
    expect(nightKey(at(28, 6, 0))).toBe('2026-09-28')
  })

  it('shifts the query window by the rollover hour', () => {
    const { startDate, endDate } = nightWindow(new Date(2026, 8, 20), 7)
    expect(startDate).toEqual(at(20, 6))
    expect(endDate.getTime()).toBe(at(27, 6).getTime() - 1)
  })

  it('groups by night and picks the longest session as the main record', () => {
    const nap = rec(1, at(27, 15), 1)
    const main = rec(2, at(27, 23), 7)
    const late = rec(3, at(28, 1), 2)
    const map = groupByNight([nap, main, late])
    expect([...map.keys()]).toEqual(['2026-09-27'])
    expect(mainRecord(map.get('2026-09-27'))).toBe(main)
    expect(mainRecord(undefined)).toBeUndefined()
  })
})

describe('formatting', () => {
  it('formats durations as hours and minutes', () => {
    expect(formatDuration(7 * 3600 + 9 * 60)).toBe('7h 9m')
    expect(formatDuration(23 * 60)).toBe('23m')
    expect(formatDuration(3600)).toBe('1h 0m')
    expect(formatDuration(0)).toBe('—')
    expect(formatDuration(null)).toBe('—')
  })

  it('collapses the month in a same-month range', () => {
    expect(formatRange(at(21, 0), at(27, 0))).toBe('Sep 21 – 27')
    expect(formatRange(at(27, 0), new Date(2026, 9, 3))).toBe('Sep 27 – Oct 3')
  })
})

describe('hypnogram geometry', () => {
  it('maps blocks to percentages clipped to the night window', () => {
    const start = at(27, 23).getTime()
    const end = at(28, 3).getTime()
    const blocks = toHypnoBlocks([
      { start: start - 3_600_000, end: start + 3_600_000, stage: 'light' },
      { start: start + 3_600_000, end: start + 2 * 3_600_000, stage: 'wake' },
      { start: end, end: end + 1000, stage: 'deep' },
    ], start, end)
    expect(blocks).toEqual([
      { stage: 'light', startPct: 0, widthPct: 25 },
      { stage: 'awake', startPct: 25, widthPct: 25 },
    ])
    expect(toHypnoBlocks([], end, start)).toEqual([])
  })

  it('labels start, odd hours away from the ends, and end', () => {
    const ticks = hypnoTicks(at(27, 23, 20).getTime(), at(28, 6, 52).getTime())
    expect(ticks.map(t => t.label)).toEqual(['11:20 PM', '1 AM', '3 AM', '5 AM', '6:52 AM'])
    expect(ticks[0].pct).toBe(0)
    expect(ticks[ticks.length - 1].pct).toBe(100)
    expect(hypnoTicks(5, 5)).toEqual([])
  })

  it('sums epoch durations per stage', () => {
    expect(stageDurations([
      { stage: 'wake', duration: 10 },
      { stage: 'rem', duration: 20 },
      { stage: 'rem', duration: 5 },
      { stage: 'deep', duration: 1 },
    ])).toEqual({ awake: 10, rem: 25, light: 0, deep: 1 })
  })

  it('downsamples long series by averaging and drops nulls', () => {
    expect(downsample([1, null, 3], 10)).toEqual([1, 3])
    expect(downsample([1, 3, 5, 7], 2)).toEqual([2, 6])
  })
})

describe('week nights', () => {
  it('builds seven nights with hours, exits and bed/wake times', () => {
    const nights = buildNights(new Date(2026, 8, 20), 7, [
      rec(1, at(21, 23), 7, 2),
      rec(2, at(22, 15), 1),
      rec(3, at(22, 23), 6),
    ])
    expect(nights).toHaveLength(7)
    expect(nights.map(n => n.key)[0]).toBe('2026-09-20')
    expect(nights[0].hours).toBe(0)
    expect(nights[0].record).toBeUndefined()
    expect(nights[1]).toMatchObject({ key: '2026-09-21', hours: 7, exits: 2, bedtime: at(21, 23), wake: at(22, 6) })
    expect(nights[2].hours).toBe(7)
    expect(nights[2].record?.id).toBe(3)
    expect(nights[1].quality).toBeNull()
  })

  it('classifies stages and averages vitals inside each night', () => {
    const r = rec(1, at(21, 23), 1)
    const vitals = Array.from({ length: 12 }, (_, i) => ({
      timestamp: new Date(at(21, 23).getTime() + i * 300_000),
      heartRate: 60,
      hrv: 40,
      breathingRate: 14,
    }))
    const outside = { timestamp: at(21, 12), heartRate: 100, hrv: 1, breathingRate: 30 }
    const [, night] = buildNights(new Date(2026, 8, 20), 2, [r], [...vitals, outside], [])
    expect(night.hr).toBe(60)
    expect(night.hrv).toBe(40)
    expect(night.br).toBe(14)
    expect(night.distribution).not.toBeNull()
    expect(night.quality).toEqual(expect.any(Number))
  })

  it('normalizes the REM/Light/Deep split and labels bars', () => {
    expect(sleepSplit({ wake: 10, rem: 18, light: 45, deep: 27 })).toEqual({ rem: 20, light: 50, deep: 30 })
    expect(sleepSplit({ wake: 100, rem: 0, light: 0, deep: 0 })).toBeUndefined()
    expect(sleepSplit(null)).toBeUndefined()
    const nights = buildNights(new Date(2026, 8, 20), 2, [])
    expect(toWeekNights(nights, true).map(n => n.label)).toEqual(['Sun 20', 'Mon 21'])
    expect(toWeekNights(nights, false).map(n => n.label)).toEqual(['S', 'M'])
  })

  it('averages clock times across midnight', () => {
    expect(averageClock([at(1, 23), at(2, 1)])?.getHours()).toBe(0)
    expect(averageClock([at(1, 22, 30), at(2, 23, 30)])?.getHours()).toBe(23)
    expect(averageClock([null])).toBeNull()
  })
})

describe('month', () => {
  it('pads the calendar to Sunday and lists every day', () => {
    const cells = monthCells(new Date(2026, 8, 1))
    expect(cells.slice(0, 2)).toEqual([null, null])
    expect(cells[2] && dayKey(cells[2])).toBe('2026-09-01')
    expect(cells).toHaveLength(2 + 30)
  })

  it('maps hours asleep to 0.1–0.6 heat', () => {
    expect(heatAlpha(4)).toBe(0.1)
    expect(heatAlpha(5)).toBe(0.1)
    expect(heatAlpha(6.5)).toBe(0.35)
    expect(heatAlpha(8)).toBe(0.6)
    expect(heatAlpha(10)).toBe(0.6)
  })

  it('lists Sunday-first weeks overlapping the month up to today', () => {
    const weeks = monthWeeks(new Date(2026, 8, 1), at(28, 12))
    expect(weeks.map(w => formatRange(w.start, w.end))).toEqual([
      'Aug 30 – Sep 5',
      'Sep 6 – 12',
      'Sep 13 – 19',
      'Sep 20 – 26',
      'Sep 27 – Oct 3',
    ])
    expect(monthWeeks(new Date(2026, 8, 1), at(10, 12))).toHaveLength(2)
  })
})
