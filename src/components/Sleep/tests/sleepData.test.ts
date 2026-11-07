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
  recordingSummary,
  monthCells,
  monthWeeks,
  nightKey,
  nightWindow,
  withNightAnalysis,
  type NightAnalysis,
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
  it('assigns sessions starting before noon to the previous night', () => {
    expect(nightKey(at(27, 23, 20))).toBe('2026-09-27')
    expect(nightKey(at(28, 0, 30))).toBe('2026-09-27')
    expect(nightKey(at(28, 5, 59))).toBe('2026-09-27')
    expect(nightKey(at(28, 11, 59))).toBe('2026-09-27')
    expect(nightKey(at(28, 12, 0))).toBe('2026-09-28')
  })

  it('shifts the query window by the rollover hour', () => {
    const { startDate, endDate } = nightWindow(new Date(2026, 8, 20), 7)
    expect(startDate).toEqual(at(20, 12))
    expect(endDate.getTime()).toBe(at(27, 12).getTime() - 1)
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

  const analysisFor = (nightDate = '2026-09-21'): NightAnalysis => ({
    epochs: [
      { start: at(21, 22).getTime(), duration: 300000, stage: 'wake', heartRate: 60, hrv: 40, breathingRate: 12, movement: 0 },
      { start: at(22, 4).getTime(), duration: 300000, stage: 'deep', heartRate: 80, hrv: 60, breathingRate: 16, movement: 0 },
    ],
    blocks: [], distribution: { wake: 50, rem: 0, light: 0, deep: 50 }, qualityScore: 17,
    totalSleepMs: 300000, totalStagedMs: 600000, sleepRecordId: null,
    enteredBedAt: at(21, 22).getTime(), leftBedAt: at(22, 5).getTime(),
    recording: { nightDate, recordIds: [1, 2, 3], start: at(21, 22).getTime(), end: at(22, 5).getTime(), durationMs: 3 * 3600000, gapsMs: 4 * 3600000, exits: 3 },
  })

  it('preserves whole-night server scores, epochs and coverage instead of classifying again', () => {
    const records = [rec(1, at(21, 22), 2, 1), rec(2, at(21, 23), 1), rec(3, at(22, 4), 1, 2)]
    const [, base] = buildNights(at(20, 0), 2, records)
    const analysis = analysisFor()
    const night = withNightAnalysis(base, analysis)
    expect(night).toMatchObject({ hours: 3, exits: 3, bedtime: at(21, 22), wake: at(22, 5), hr: 70, hrv: 50, br: 14, asleepSeconds: 300, quality: 17 })
    expect(night.analysis).toBe(analysis)
    expect(night.distribution).toBe(analysis.distribution)
    expect(toWeekNights([night], true)[0]).toMatchObject({ hours: 3, quality: 17, split: null })
  })

  it('does not invent stages, scores or zero sleep without a server result', () => {
    const [, base] = buildNights(at(20, 0), 2, [rec(1, at(21, 23), 1)])
    expect(withNightAnalysis(base)).toEqual(base)
    expect(base).toMatchObject({ quality: null, distribution: null, hr: null, asleepSeconds: null })
    expect(toWeekNights([base], true)[0].split).toBeNull()
  })

  it('does not apply a result for a different calendar night', () => {
    const [, base] = buildNights(at(20, 0), 2, [rec(1, at(21, 23), 1)])
    expect(withNightAnalysis(base, analysisFor('2026-09-20'))).toBe(base)
  })

  it('distinguishes zero estimated sleep from missing stages', () => {
    const [, base] = buildNights(at(20, 0), 2, [rec(1, at(21, 23), 1)])
    const analysis = analysisFor()
    analysis.epochs = analysis.epochs.map(epoch => ({ ...epoch, stage: 'wake' }))
    expect(withNightAnalysis(base, analysis).asleepSeconds).toBe(0)
    analysis.epochs = []
    expect(withNightAnalysis(base, analysis)).toMatchObject({ asleepSeconds: null, quality: null, distribution: null })
  })

  it('labels bars without fabricating REM/Light/Deep portions for recorded hours', () => {
    const nights = buildNights(new Date(2026, 8, 20), 2, [])
    expect(toWeekNights(nights, true).map(night => night.label)).toEqual(['Sun 20', 'Mon 21'])
    expect(toWeekNights(nights, false).map(night => night.label)).toEqual(['S', 'M'])
    expect(toWeekNights(nights, false).every(night => night.split === null)).toBe(true)
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

describe('whole-night recordings', () => {
  it('counts morning fragments and overlapping windows only once, leaving gaps unknown', () => {
    const records = [rec(1, at(27, 22), 3), rec(2, at(28, 1, 30), 3), rec(3, at(28, 6, 30), 1), rec(4, at(27, 23), 1)]
    const groups = groupByNight(records)
    expect(groups.size).toBe(1)
    expect(recordingSummary(records)).toEqual({ start: at(27, 22).getTime(), end: at(28, 7, 30).getTime(), seconds: 7 * 3600, gaps: 2.5 * 3600, count: 4 })
  })
  it('does not extrapolate open records to now or accept inverted windows', () => {
    expect(recordingSummary([{ ...rec(1, at(27, 22), 1), leftBedAt: null }, { ...rec(2, at(27, 23), 1), leftBedAt: at(27, 22) }]).seconds).toBe(3600)
  })
})
