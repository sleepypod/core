import { describe, expect, it } from 'vitest'
import {
  nextPoint, nightCurve, nightMismatch, powerIntervals, presenceIntervals, targetAt, tempRange, timelineWindow,
} from '../timelineLogic'

const at = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).getTime()
const row = (dayOfWeek: string, time: string, temperature: number, enabled = true) => ({ dayOfWeek, time, temperature, enabled })

describe('timelineWindow', () => {
  it('runs 6 PM before last night to 9 AM after tonight', () => {
    const w = timelineWindow(new Date(2026, 8, 28, 19, 0)) // Monday evening
    expect(w.start).toBe(at(27, 18))
    expect(w.end).toBe(at(29, 9))
    expect(w.nights.map(n => n.midnight.getDate())).toEqual([27, 28])
  })
  it('keeps the night in progress as tonight until 9 AM', () => {
    const w = timelineWindow(new Date(2026, 8, 29, 6, 0))
    expect(w.nights[1].midnight.getDate()).toBe(28)
    expect(w.start).toBe(at(27, 18))
  })
})

describe('nightCurve', () => {
  const temps = [
    row('sunday', '23:00', 80), row('sunday', '01:00', 70), row('sunday', '07:00', 84),
    row('sunday', '12:00', 99, false), row('monday', '23:00', 75),
  ]
  it('places overnight points on the morning after', () => {
    expect(nightCurve(temps, new Date(2026, 8, 27))).toEqual([
      { at: at(27, 23), temperature: 80 },
      { at: at(28, 1), temperature: 70 },
      { at: at(28, 7), temperature: 84 },
    ])
  })
  it('moves a curve saved entirely after midnight to the next morning', () => {
    const early = [row('sunday', '01:00', 70), row('sunday', '06:00', 82)]
    expect(nightCurve(early, new Date(2026, 8, 27)).map(p => p.at)).toEqual([at(28, 1), at(28, 6)])
  })
  it('is empty without enabled points for that day', () => {
    expect(nightCurve(temps, new Date(2026, 8, 29))).toEqual([])
    expect(nightCurve(undefined, new Date(2026, 8, 27))).toEqual([])
  })
})

describe('presenceIntervals', () => {
  const from = at(27, 18)
  const to = at(29, 9)
  it('uses present intervals (epoch seconds) so exits show as gaps', () => {
    const rec = {
      enteredBedAt: new Date(at(28, 4)),
      leftBedAt: new Date(at(28, 8)),
      presentIntervals: [[at(28, 4) / 1000, at(28, 5) / 1000], [at(28, 6) / 1000, at(28, 8) / 1000]],
    }
    expect(presenceIntervals([rec], from, to, at(28, 19))).toEqual([
      { start: at(28, 4), end: at(28, 5) },
      { start: at(28, 6), end: at(28, 8) },
    ])
  })
  it('falls back to entered → left, runs an open session to now, and clips to the window', () => {
    const open = { enteredBedAt: new Date(at(28, 22)), leftBedAt: null, presentIntervals: [] }
    const early = { enteredBedAt: new Date(at(27, 10)), leftBedAt: new Date(at(27, 20)), presentIntervals: null }
    expect(presenceIntervals([open, early], from, to, at(28, 23))).toEqual([
      { start: from, end: at(27, 20) },
      { start: at(28, 22), end: at(28, 23) },
    ])
  })
})

describe('powerIntervals', () => {
  it('merges powered buckets across short gaps and splits on long ones', () => {
    const b = 240_000
    const pts = [0, 1, 2, 4, 10, 11].map(i => ({ t: i * b + b / 2, leftTarget: 78 }))
      .concat([{ t: 5 * b + b / 2, leftTarget: null as unknown as number }])
      .sort((x, y) => x.t - y.t)
    expect(powerIntervals(pts, 'leftTarget', b)).toEqual([
      { start: 0, end: 5 * b },
      { start: 10 * b, end: 12 * b },
    ])
    expect(powerIntervals(undefined, 'leftTarget', b)).toEqual([])
  })
})

describe('nightMismatch', () => {
  const curve = [{ at: at(27, 23, 15), temperature: 80 }, { at: at(28, 7), temperature: 84 }]
  it('flags the bed empty while the schedule ran and a lie-in past its end', () => {
    const m = nightMismatch(curve, [{ start: at(28, 4, 5), end: at(28, 6) }, { start: at(28, 6, 10), end: at(28, 8, 22) }])
    expect(m.emptyBefore).toEqual({ start: at(27, 23, 15), end: at(28, 4, 5) })
    expect(at(28, 4, 5) - at(27, 23, 15)).toBe((4 * 60 + 50) * 60_000)
    expect(m.pastEnd).toEqual({ start: at(28, 7), end: at(28, 8, 22) })
  })
  it('ignores gaps under 15 minutes and presence from other nights', () => {
    expect(nightMismatch(curve, [{ start: at(27, 23, 20), end: at(28, 7, 5) }])).toEqual({ emptyBefore: null, pastEnd: null })
    expect(nightMismatch(curve, [{ start: at(28, 20), end: at(28, 22) }])).toEqual({ emptyBefore: null, pastEnd: null })
    expect(nightMismatch([curve[0]], [{ start: at(28, 1), end: at(28, 2) }])).toEqual({ emptyBefore: null, pastEnd: null })
  })
})

describe('nextPoint / tempRange', () => {
  const a = [{ at: at(27, 23), temperature: 80 }, { at: at(28, 7), temperature: 84 }]
  const b = [{ at: at(28, 23), temperature: 75 }, { at: at(29, 7), temperature: 82 }]
  it('finds the first set point after now across nights', () => {
    expect(nextPoint([a, b], at(28, 19))).toEqual(b[0])
    expect(nextPoint([a, b], at(29, 8))).toBeNull()
  })
  it('pads the range by 1° and keeps it at least 6° tall', () => {
    expect(tempRange([a, b])).toEqual({ lo: 74, hi: 85 })
    expect(tempRange([[{ at: 0, temperature: 80 }]])).toEqual({ lo: 77, hi: 83 })
    expect(tempRange([[], []])).toBeNull()
  })
})

describe('targetAt', () => {
  it('reads the held set point from whichever curve covers the moment', () => {
    const a = [{ at: 100, temperature: 76 }, { at: 200, temperature: 72 }, { at: 300, temperature: 84 }]
    const b = [{ at: 1000, temperature: 80 }, { at: 1100, temperature: 80 }]
    expect(targetAt([a, b], 99)).toBeNull()
    expect(targetAt([a, b], 100)).toBe(76)
    expect(targetAt([a, b], 250)).toBe(72)
    expect(targetAt([a, b], 300)).toBe(84)
    expect(targetAt([a, b], 500)).toBeNull()
    expect(targetAt([a, b], 1050)).toBe(80)
    expect(targetAt([[]], 0)).toBeNull()
  })
})
