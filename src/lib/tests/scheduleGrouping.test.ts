import { describe, expect, test } from 'vitest'
import { groupDaysBySharedCurve, simplifySetPoints, sortChronological } from '../scheduleGrouping'

describe('sortChronological', () => {
  test('returns a copy (does not mutate input) when length <= 1', () => {
    const single = [{ time: '08:00', temperature: 70 }]
    const result = sortChronological(single)
    expect(result).toEqual(single)
    expect(result).not.toBe(single)
    expect(result[0]).toBe(single[0])
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

describe('simplifySetPoints', () => {
  // The Pod 5 curve that prompted this: a 79° hold written as nine rows.
  const curve = [
    ['23:15', 80], ['23:29', 81], ['23:43', 81], ['23:57', 82], ['00:12', 81], ['00:27', 80],
    ['00:41', 79], ['00:56', 79], ['01:16', 79], ['01:36', 79], ['02:15', 79], ['02:55', 79],
    ['03:09', 79], ['03:23', 79], ['03:37', 79], ['04:44', 79], ['05:50', 79],
    ['06:04', 81], ['06:18', 83], ['06:32', 85], ['06:41', 83], ['06:51', 82], ['07:00', 80],
  ].map(([time, temperature]) => ({ time: time as string, temperature: temperature as number }))

  test('keeps only the first and last point of each flat run', () => {
    const out = simplifySetPoints(curve)
    expect(out.map(p => p.time)).toEqual([
      '23:15', '23:29', '23:43', '23:57', '00:12', '00:27', '00:41', '05:50',
      '06:04', '06:18', '06:32', '06:41', '06:51', '07:00',
    ])
  })

  test('returns points in overnight chronological order and keeps their extra fields', () => {
    const points = [
      { id: 1, time: '06:00', temperature: 80 },
      { id: 2, time: '22:00', temperature: 75 },
      { id: 3, time: '02:00', temperature: 75 },
      { id: 4, time: '00:00', temperature: 75 },
    ]
    // 00:00 stays: it's the first row past midnight (see below).
    expect(simplifySetPoints(points).map(p => p.id)).toEqual([2, 4, 3, 1])
  })

  test('keeps the first point after midnight, which follows the previous day\'s evening', () => {
    // Monday's 00:00 row fires Monday morning, after Sunday's evening rows; dropping
    // it would leave Sunday's temperature running until 06:00.
    const flat = [{ time: '22:00', temperature: 78 }, { time: '00:00', temperature: 78 }, { time: '03:00', temperature: 78 }, { time: '06:00', temperature: 78 }]
    expect(simplifySetPoints(flat).map(p => p.time)).toEqual(['22:00', '00:00', '06:00'])
  })

  test('never opens a gap over 12h, so a daytime curve stays daytime when saved again', () => {
    const day = [{ time: '08:00', temperature: 78 }, { time: '12:00', temperature: 78 }, { time: '18:00', temperature: 78 }, { time: '22:00', temperature: 78 }]
    const once = simplifySetPoints(day)
    expect(once.map(p => p.time)).toEqual(['08:00', '18:00', '22:00'])
    expect(simplifySetPoints(once)).toEqual(once)
    expect(sortChronological(once).map(p => p.time)).toEqual(['08:00', '18:00', '22:00'])
  })

  test('always keeps the power-on and power-off points', () => {
    const flat = [{ time: '22:00', temperature: 78 }, { time: '23:00', temperature: 78 }, { time: '06:00', temperature: 78 }]
    expect(simplifySetPoints(flat).map(p => p.time)).toEqual(['22:00', '06:00'])
    expect(simplifySetPoints([flat[0]])).toEqual([flat[0]])
    expect(simplifySetPoints([])).toEqual([])
  })

  test('keeps sloped points, which the scheduler sends as steps', () => {
    const ramp = [{ time: '06:00', temperature: 80 }, { time: '06:15', temperature: 82 }, { time: '06:30', temperature: 84 }]
    expect(simplifySetPoints(ramp)).toEqual(ramp)
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

  test('sorts a Sunday active curve before a larger empty-day group', () => {
    const groups = groupDaysBySharedCurve([
      { dayOfWeek: 'sunday', time: '09:00', temperature: 70, enabled: true },
    ])

    expect(groups[0].days).toEqual(['sunday'])
    expect(groups[0].setPoints).toEqual([{ time: '09:00', temperature: 70 }])
  })

  test('sorts a Monday active curve before an earlier, larger empty-day group', () => {
    const groups = groupDaysBySharedCurve([
      { dayOfWeek: 'monday', time: '09:00', temperature: 70, enabled: true },
    ])

    expect(groups[0].days).toEqual(['monday'])
    expect(groups[0].setPoints).toEqual([{ time: '09:00', temperature: 70 }])
  })

  test('sorts a shared two-day curve before an earlier one-day curve', () => {
    const groups = groupDaysBySharedCurve([
      { dayOfWeek: 'sunday', time: '09:00', temperature: 70, enabled: true },
      { dayOfWeek: 'monday', time: '10:00', temperature: 71, enabled: true },
      { dayOfWeek: 'tuesday', time: '10:00', temperature: 71, enabled: true },
    ]).filter(group => group.setPoints.length > 0)

    expect(groups.map(group => group.days)).toEqual([
      ['monday', 'tuesday'],
      ['sunday'],
    ])
  })
})

test('keeps identical curves with different end actions separate, including paused curves', () => {
  for (const enabled of [true, false]) {
    const temps = ['monday', 'tuesday'].map(dayOfWeek => ({ dayOfWeek, time: '22:00', temperature: 75, enabled }))
    const groups = groupDaysBySharedCurve(temps, [
      { dayOfWeek: 'monday', endAction: 'maintain' },
      { dayOfWeek: 'tuesday', endAction: 'turn_off' },
    ]).filter(g => g.setPoints.length > 0)
    expect(groups).toHaveLength(2)
    expect(groups.find(g => g.days.includes('monday'))?.endAction).toBe('maintain')
    expect(groups.find(g => g.days.includes('tuesday'))?.endAction).toBe('turn_off')
  }
})
