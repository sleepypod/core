import { describe, expect, test } from 'vitest'
import { groupDaysBySharedCurve, sortChronological } from '../scheduleGrouping'

describe('sortChronological', () => {
  test('returns a copy (does not mutate input) when length <= 1', () => {
    const single = [{ time: '08:00', temperature: 70 }]
    const result = sortChronological(single)
    expect(result).toEqual(single)
    expect(result).not.toBe(single)
    expect(sortChronological([])).toEqual([])
  })

  test('sorts a normal daytime schedule chronologically', () => {
    const points = [
      { time: '14:00', temperature: 72 },
      { time: '08:00', temperature: 70 },
      { time: '20:00', temperature: 68 },
    ]
    expect(sortChronological(points)).toEqual([
      { time: '08:00', temperature: 70 },
      { time: '14:00', temperature: 72 },
      { time: '20:00', temperature: 68 },
    ])
  })

  test('shifts early-morning times after evening for overnight schedules', () => {
    const points = [
      { time: '00:30', temperature: 65 },
      { time: '06:00', temperature: 68 },
      { time: '22:00', temperature: 72 },
    ]
    // Gap > 12h between 06:00 and 22:00 → overnight; 22:00 sorts first.
    expect(sortChronological(points)).toEqual([
      { time: '22:00', temperature: 72 },
      { time: '00:30', temperature: 65 },
      { time: '06:00', temperature: 68 },
    ])
  })

  test('treats schedules without a >12h gap as plain daytime sort', () => {
    const points = [
      { time: '23:00', temperature: 68 },
      { time: '12:00', temperature: 72 },
    ]
    // 12:00 → 23:00 = 11h gap, so plain chronological
    expect(sortChronological(points)).toEqual([
      { time: '12:00', temperature: 72 },
      { time: '23:00', temperature: 68 },
    ])
  })

  test('orders minute components arithmetically within the same hour', () => {
    expect(sortChronological([
      { time: '12:50', temperature: 68 },
      { time: '12:10', temperature: 72 },
    ])).toEqual([
      { time: '12:10', temperature: 72 },
      { time: '12:50', temperature: 68 },
    ])
  })

  test('does not treat an exact twelve-hour gap as an overnight wrap', () => {
    expect(sortChronological([
      { time: '12:00', temperature: 68 },
      { time: '00:00', temperature: 72 },
    ])).toEqual([
      { time: '00:00', temperature: 72 },
      { time: '12:00', temperature: 68 },
    ])
  })
})

describe('groupDaysBySharedCurve', () => {
  test('returns a single empty group for no schedules', () => {
    const groups = groupDaysBySharedCurve([])
    expect(groups).toHaveLength(1)
    expect(groups[0].days).toEqual([
      'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday',
    ])
    expect(groups[0].setPoints).toEqual([])
    expect(groups[0].allDisabled).toBeUndefined()
    expect(groups[0].key).toBe('__empty__')
  })

  test('groups identical curves across days regardless of input ordering', () => {
    const schedules = [
      { dayOfWeek: 'monday', time: '08:00', temperature: 70, enabled: true },
      { dayOfWeek: 'monday', time: '22:00', temperature: 65, enabled: true },
      // Tuesday has the same set points entered in reverse order
      { dayOfWeek: 'tuesday', time: '22:00', temperature: 65, enabled: true },
      { dayOfWeek: 'tuesday', time: '08:00', temperature: 70, enabled: true },
    ]
    const groups = groupDaysBySharedCurve(schedules)
    const matched = groups.find(g => g.days.includes('monday'))
    expect(matched).toBeDefined()
    if (!matched) return
    expect(matched.days).toEqual(['monday', 'tuesday'])
  })

  test('uses temperature as the fingerprint tiebreaker for duplicate times', () => {
    const groups = groupDaysBySharedCurve([
      { dayOfWeek: 'monday', time: '08:00', temperature: 72, enabled: true },
      { dayOfWeek: 'monday', time: '08:00', temperature: 68, enabled: true },
      { dayOfWeek: 'tuesday', time: '08:00', temperature: 68, enabled: true },
      { dayOfWeek: 'tuesday', time: '08:00', temperature: 72, enabled: true },
    ])

    const shared = groups.find(group => group.days.includes('monday'))
    expect(shared?.days).toEqual(['monday', 'tuesday'])
    expect(shared?.key).toBe('08:00@68|08:00@72')
  })

  test('keeps days with paused schedules separate from active days', () => {
    const schedules = [
      { dayOfWeek: 'monday', time: '08:00', temperature: 70, enabled: true },
      { dayOfWeek: 'tuesday', time: '08:00', temperature: 70, enabled: false },
    ]
    const groups = groupDaysBySharedCurve(schedules)
    const monday = groups.find(g => g.days.includes('monday'))
    const tuesday = groups.find(g => g.days.includes('tuesday'))
    expect(monday).toBeDefined()
    expect(tuesday).toBeDefined()
    if (!monday || !tuesday) return
    expect(monday.allDisabled).toBeUndefined()
    expect(tuesday.allDisabled).toBe(true)
    expect(tuesday.key).toBe('__disabled__:08:00@70')
    // Paused days still surface their saved curve
    expect(tuesday.setPoints).toEqual([{ time: '08:00', temperature: 70 }])
  })

  test('paused days with different saved curves form separate groups', () => {
    const schedules = [
      { dayOfWeek: 'monday', time: '08:00', temperature: 70, enabled: false },
      { dayOfWeek: 'tuesday', time: '09:00', temperature: 72, enabled: false },
    ]
    const groups = groupDaysBySharedCurve(schedules)
    const monday = groups.find(g => g.days.includes('monday'))
    const tuesday = groups.find(g => g.days.includes('tuesday'))
    expect(monday).toBeDefined()
    expect(tuesday).toBeDefined()
    if (!monday || !tuesday) return
    expect(monday).not.toBe(tuesday)
    expect(monday.allDisabled).toBe(true)
    expect(tuesday.allDisabled).toBe(true)
  })

  test('sorts active groups before disabled, then by day count, then by earliest day', () => {
    const schedules = [
      { dayOfWeek: 'monday', time: '08:00', temperature: 70, enabled: true },
      { dayOfWeek: 'tuesday', time: '08:00', temperature: 70, enabled: true },
      { dayOfWeek: 'wednesday', time: '08:00', temperature: 70, enabled: true },
      // single active day with a different curve
      { dayOfWeek: 'thursday', time: '09:00', temperature: 75, enabled: true },
      // disabled day
      { dayOfWeek: 'friday', time: '08:00', temperature: 70, enabled: false },
    ]
    const groups = groupDaysBySharedCurve(schedules)
    // Active groups first
    expect(groups[0].setPoints.length).toBeGreaterThan(0)
    expect(groups[0].allDisabled).toBeUndefined()
    // Most-days-active group is first
    expect(groups[0].days).toEqual(['monday', 'tuesday', 'wednesday'])
    // Disabled is later than active
    const disabledIdx = groups.findIndex(g => g.allDisabled)
    const emptyIdx = groups.findIndex(g => g.setPoints.length === 0 && !g.allDisabled)
    expect(disabledIdx).toBeGreaterThan(0)
    if (emptyIdx >= 0) expect(emptyIdx).toBeGreaterThan(disabledIdx)
  })

  test('sorts an overnight curve correctly inside the group', () => {
    const schedules = [
      { dayOfWeek: 'monday', time: '06:00', temperature: 68, enabled: true },
      { dayOfWeek: 'monday', time: '22:00', temperature: 72, enabled: true },
      { dayOfWeek: 'monday', time: '00:30', temperature: 65, enabled: true },
    ]
    const groups = groupDaysBySharedCurve(schedules)
    const monday = groups.find(g => g.days.includes('monday'))
    expect(monday).toBeDefined()
    if (!monday) return
    expect(monday.setPoints.map(p => p.time)).toEqual(['22:00', '00:30', '06:00'])
  })

  test('sorts equal-sized active groups by their earliest weekday', () => {
    const groups = groupDaysBySharedCurve([
      { dayOfWeek: 'sunday', time: '09:00', temperature: 70, enabled: true },
      { dayOfWeek: 'monday', time: '10:00', temperature: 71, enabled: true },
      { dayOfWeek: 'tuesday', time: '11:00', temperature: 72, enabled: true },
    ]).filter(group => group.setPoints.length > 0 && !group.allDisabled)

    expect(groups.map(group => group.days[0])).toEqual(['sunday', 'monday', 'tuesday'])
  })
})
