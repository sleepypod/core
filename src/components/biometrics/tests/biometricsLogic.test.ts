import { describe, expect, it } from 'vitest'
import {
  BREAK_PX, baselineBand, clampTo, fmtDuration, fmtGap, formatRangeLabel, layoutAxis, metricStats, nearestIndex,
  nightWindow, percentile, rangeWindow, rollingMean, segmentTicks, sessionHeader, splitSessions, STALL_PX,
  type VitalPoint,
} from '../biometricsLogic'

const MIN = 60_000
const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime()
const pt = (t: number, hr: number | null = 60, hrv: number | null = 40, br: number | null = 16): VitalPoint => ({ t, hr, hrv, br })

describe('ranges', () => {
  it('uses the noon-to-noon night and the last 7/30 calendar days', () => {
    expect(nightWindow(at(28, 1))).toEqual({ start: at(27, 12), end: at(28, 12) })
    expect(nightWindow(at(28, 19))).toEqual({ start: at(28, 12), end: at(29, 12) })
    expect(rangeWindow('week', at(28, 19))).toEqual({ start: at(22, 0), end: at(29, 0) })
    expect(rangeWindow('month', at(28, 19)).start).toBe(new Date(2026, 7, 30).getTime())
  })

  it('labels a range', () => {
    expect(formatRangeLabel({ start: at(22, 0), end: at(29, 0) })).toBe('Sep 22–28')
    expect(formatRangeLabel({ start: new Date(2026, 7, 30).getTime(), end: at(29, 0) })).toBe('Aug 30–Sep 28')
    expect(formatRangeLabel({ start: at(28, 0), end: at(28, 23) })).toBe('Sep 28')
  })
})

describe('sessions', () => {
  it('starts a new session after a gap longer than 30 minutes', () => {
    const pts = [pt(at(27, 4, 5)), pt(at(27, 4, 6)), pt(at(27, 4, 36)), pt(at(28, 12, 52)), pt(at(28, 12, 53))]
    const s = splitSessions(pts.reverse())
    expect(s.map(x => [x.start, x.end, x.points.length])).toEqual([
      [at(27, 4, 5), at(27, 4, 36), 3],
      [at(28, 12, 52), at(28, 12, 53), 2],
    ])
  })

  it('smooths with a centred 9-minute mean and leaves null readings null', () => {
    const pts = Array.from({ length: 11 }, (_, i) => pt(at(28, 1, i), i === 5 ? null : i * 10))
    const m = rollingMean(pts, 'hr')
    expect(m[5]).toBeNull()
    // Minute 0 averages minutes 0–4.
    expect(m[0]).toBe((0 + 10 + 20 + 30 + 40) / 5)
    // Minute 6 averages 2–10 except the null at 5.
    expect(m[6]).toBeCloseTo((20 + 30 + 40 + 60 + 70 + 80 + 90 + 100) / 8)
  })

  it('computes the p25–p75 band and per-session stats', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.25)).toBe(2)
    expect(percentile([], 0.5)).toBeNull()
    const pts = [50, 60, 70, 80, 90].map((v, i) => pt(at(28, 1, i), v))
    expect(baselineBand(pts, 'hr')).toEqual({ lo: 60, hi: 80 })
    expect(baselineBand([pt(0, null)], 'hr')).toBeNull()
    expect(metricStats(pts, 'hr')).toEqual({ avg: 70, min: 50, max: 90 })
    expect(metricStats([pt(0, null)], 'hr')).toBeNull()
  })

  it('snaps to the nearest reading', () => {
    const pts = [pt(0), pt(60_000), pt(120_000)]
    expect(nearestIndex(pts, 50_000)).toBe(1)
    expect(nearestIndex(pts, 20_000)).toBe(0)
    expect(nearestIndex(pts, 999_999)).toBe(2)
  })

  it('clamps to the chart domain', () => {
    expect(clampTo(120, [36, 90])).toBe(90)
    expect(clampTo(20, [36, 90])).toBe(36)
  })
})

describe('formatting', () => {
  it('formats durations and gaps', () => {
    expect(fmtDuration(236 * MIN)).toBe('3h 56m')
    expect(fmtDuration(369 * MIN)).toBe('6h 09m')
    expect(fmtDuration(42 * MIN)).toBe('42m')
    expect(fmtGap(28 * 60 * MIN)).toBe('28 h')
    expect(fmtGap(72 * 60 * MIN)).toBe('3 d')
    expect(fmtGap(45 * MIN)).toBe('45 min')
    expect(sessionHeader({ start: at(27, 4, 5), end: at(27, 8, 22) })).toBe('SUN SEP 27 · 4h 17m')
  })
})

describe('x axis', () => {
  it('sizes sessions by duration with fixed breaks and a fixed stall segment', () => {
    const sessions = [{ start: 0, end: 3 * 60 * MIN }, { start: 30 * 60 * MIN, end: 31 * 60 * MIN }]
    const width = 1000
    const a = layoutAxis(sessions, width, { start: 31 * 60 * MIN, end: 34 * 60 * MIN })
    const available = width - BREAK_PX - STALL_PX
    expect(a.segments[0]).toMatchObject({ kind: 'session', x: 0 })
    expect(a.segments[0].w).toBeCloseTo(available * 0.75)
    expect(a.segments[1].x).toBeCloseTo(available * 0.75 + BREAK_PX)
    expect(a.segments[2]).toMatchObject({ kind: 'stall', w: STALL_PX })
    expect(a.segments[2].x + STALL_PX).toBeCloseTo(width)
    expect(a.breaks).toEqual([{ x: expect.any(Number), gapMs: 27 * 60 * MIN }])
    expect(a.xOf(a.segments[0], 90 * MIN)).toBeCloseTo(available * 0.375)
  })

  it('ticks on the hour and labels the session start unless it crowds the first hour', () => {
    const ticks = segmentTicks({ start: at(27, 4, 5), end: at(27, 8, 22), w: 500 })
    expect(ticks.map(t => t.label)).toEqual(['4:05', '5 AM', '6 AM', '7 AM', '8 AM'])
    const crowded = segmentTicks({ start: at(28, 12, 52), end: at(28, 15, 5), w: 300 })
    expect(crowded.map(t => t.label)).toEqual(['1 PM', '2 PM', '3 PM'])
    const dense = segmentTicks({ start: at(27, 0), end: at(28, 0), w: 200 })
    expect(dense.length).toBeLessThanOrEqual(5)
  })
})
