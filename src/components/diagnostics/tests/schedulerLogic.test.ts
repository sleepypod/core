import { describe, expect, it } from 'vitest'
import {
  buildNights, describeSchedule, fmtIn, fmtWhen, groupCounts, heldTarget, jobText, jobTypeLabel, nightAxis, podLane, sideLane,
  type TimelineOccurrence,
} from '../schedulerLogic'

const HOUR = 3_600_000
const sideName = (s: 'left' | 'right') => (s === 'left' ? 'Jon' : 'Right')
const occ = (over: Partial<TimelineOccurrence>): TimelineOccurrence => ({ id: 'x', type: 'temperature', at: 0, targetTempF: null, brightness: null, ...over })

describe('labels', () => {
  it('uses plain names for job types', () => {
    expect(jobTypeLabel('led_brightness')).toBe('LED')
    expect(jobTypeLabel('power_on')).toBe('Power on')
    expect(jobTypeLabel('something_new')).toBe('Something new')
  })

  it('reads a job as subject → value', () => {
    expect(jobText(occ({ side: 'left', targetTempF: 80 }), sideName)).toEqual({ subject: 'Jon', value: '80°F', tone: 'neutral' })
    expect(jobText(occ({ side: 'right', targetTempF: 72 }), sideName).tone).toBe('cool')
    expect(jobText(occ({ type: 'power_off', side: 'left' }), sideName).value).toBe('off')
    expect(jobText(occ({ type: 'led_brightness', brightness: 2 }), sideName)).toMatchObject({ subject: 'LED', value: '2%' })
    expect(jobText(occ({ type: 'reboot' }), sideName)).toMatchObject({ subject: 'Reboot', value: '' })
  })
})

describe('groupCounts', () => {
  it('puts every job in one group so the parts add up to the total', () => {
    const jobs = [
      ...Array.from({ length: 5 }, () => ({ type: 'temperature' })),
      { type: 'power_on' }, { type: 'power_off' },
      { type: 'prime' }, { type: 'reboot' }, { type: 'calibration' },
      { type: 'led_brightness' }, { type: 'away_mode' }, { type: 'brand_new' },
    ]
    const groups = groupCounts(jobs)
    expect(groups.map(g => [g.id, g.count])).toEqual([['temperature', 5], ['power', 2], ['maintenance', 3], ['other', 3]])
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(jobs.length)
  })

  it('omits empty groups like an unused alarm', () => {
    expect(groupCounts([{ type: 'temperature' }]).map(g => g.id)).toEqual(['temperature'])
  })
})

describe('time wording', () => {
  const now = new Date(2026, 8, 28, 17, 34).getTime()
  it('drops the date for today and seconds everywhere', () => {
    expect(fmtWhen(new Date(2026, 8, 28, 23, 15).getTime(), now)).toMatch(/^11:15\sPM$/)
    expect(fmtWhen(new Date(2026, 8, 29, 3, 0).getTime(), now)).toMatch(/^Tue 3:00\sAM$/)
  })
  it('says how long until a job', () => {
    expect(fmtIn(now + 341 * 60_000, now)).toBe('in 5h 41m')
    expect(fmtIn(now + 30_000, now)).toBe('now')
    expect(fmtIn(now + 26 * HOUR, now)).toBe('in 1d 2h')
  })
  it('describes a cron in words', () => {
    expect(describeSchedule({ schedule: '0 3 * * *', oneTime: false })).toMatch(/^Daily 3:00\sAM$/)
    expect(describeSchedule({ schedule: '15 23 * * 1,3', oneTime: false })).toMatch(/^Mon, Wed 11:15\sPM$/)
    expect(describeSchedule({ schedule: '*/5 * * * *', oneTime: false })).toBe('*/5 * * * *')
    expect(describeSchedule({ schedule: '2026-10-01T10:00:00.000Z', oneTime: true })).toMatch(/^Once · /)
  })
})

describe('nights', () => {
  it('starts with the night in progress and buckets every occurrence', () => {
    const now = new Date(2026, 8, 29, 2, 0).getTime() // 2 AM Tue: still Monday night
    const monNight = new Date(2026, 8, 28, 23, 0).getTime()
    const wedNight = new Date(2026, 8, 30, 22, 0).getTime()
    const nights = buildNights([occ({ at: monNight }), occ({ at: wedNight })], now)
    expect(nights).toHaveLength(7)
    expect(nights[0].label).toBe('Tonight')
    expect(nights[0].occurrences).toHaveLength(1)
    expect(nights[1].occurrences).toHaveLength(0)
    expect(nights[2].occurrences).toHaveLength(1)
  })

  it('shows 5 PM to 9 AM, widened for earlier or later jobs', () => {
    const start = new Date(2026, 8, 28, 12, 0).getTime()
    expect(nightAxis({ start, occurrences: [] })).toEqual({ from: start + 5 * HOUR, to: start + 21 * HOUR })
    const wide = nightAxis({ start, occurrences: [occ({ side: 'left', at: start + 2.5 * HOUR }), occ({ side: 'right', at: start + 22.5 * HOUR })] })
    expect(wide).toEqual({ from: start + 2 * HOUR, to: start + 23 * HOUR })
    // A midday reboot doesn't stretch the night.
    expect(nightAxis({ start, occurrences: [occ({ type: 'reboot', at: start + 1 * HOUR })] })).toEqual({ from: start + 5 * HOUR, to: start + 21 * HOUR })
  })

  it('splits lanes by side and pod', () => {
    const list = [
      occ({ id: 'on', type: 'power_on', side: 'left', at: 1, targetTempF: 80 }),
      occ({ id: 't', side: 'left', at: 2, targetTempF: 78 }),
      occ({ id: 'off', type: 'power_off', side: 'left', at: 3 }),
      occ({ id: 'a', type: 'alarm', side: 'left', at: 4, targetTempF: 82 }),
      occ({ id: 'r', side: 'right', at: 2, targetTempF: 70 }),
      occ({ id: 'led', type: 'led_brightness', at: 5, brightness: 2 }),
    ]
    const left = sideLane(list, 'left')
    expect(left.points.map(p => p.id)).toEqual(['on', 't'])
    expect(left).toMatchObject({ on: [1], off: [3], alarms: [4] })
    expect(podLane(list).map(o => o.id)).toEqual(['led'])
  })
})

describe('heldTarget', () => {
  const lane = sideLane([
    occ({ id: 'a', side: 'left', at: 10 * HOUR, targetTempF: 80 }),
    occ({ id: 'b', side: 'left', at: 12 * HOUR, targetTempF: 72 }),
    occ({ id: 'off', type: 'power_off', side: 'left', at: 18 * HOUR }),
  ], 'left')

  it('holds the last set point until the side powers off', () => {
    expect(heldTarget(lane, 9 * HOUR)).toBeNull()
    expect(heldTarget(lane, 10 * HOUR)).toBe(80)
    expect(heldTarget(lane, 13 * HOUR)).toBe(72)
    expect(heldTarget(lane, 18 * HOUR)).toBeNull()
    expect(heldTarget(lane, 20 * HOUR)).toBeNull()
  })
})
