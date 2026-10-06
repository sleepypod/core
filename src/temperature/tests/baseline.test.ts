import { describe, expect, it, vi } from 'vitest'
import * as cronParser from 'cron-parser'
import { ALARM_HOLD_AFTER_MIN, ALARM_WARMUP_MIN, alarmTemperatureTargets, alarmWarmupMinutes, recurringTarget, sessionTarget, type WeeklyTarget, type RecurringOccurrenceCache } from '../baseline'

vi.mock('cron-parser', async (importOriginal) => {
  const original = await importOriginal<typeof cronParser>()
  return { ...original, parseExpression: vi.fn(original.parseExpression) }
})

describe('current recurring target', () => {
  const rows: WeeklyTarget[] = [
    { id: 'bedtime', dayOfWeek: 'monday', time: '22:00', temperature: 75 },
    { id: 'overnight', dayOfWeek: 'tuesday', time: '02:00', temperature: 68 },
  ]

  it('selects the current point across midnight and includes an exact firing boundary', () => {
    expect(recurringTarget(rows, 'UTC', Date.parse('2026-09-29T01:00Z'))?.temperature).toBe(75)
    expect(recurringTarget(rows, 'UTC', Date.parse('2026-09-29T02:00Z'))?.temperature).toBe(68)
    expect(recurringTarget(rows, 'UTC', Date.parse('2026-09-29T03:00Z'))?.temperature).toBe(68)
  })

  it('uses the configured zone rather than the server zone', () => {
    const now = Date.parse('2026-09-29T05:30Z') // Monday 22:30 PDT
    expect(recurringTarget(rows, 'America/Los_Angeles', now)?.temperature).toBe(75)
  })

  it('handles weekly rollover and has no target when schedules are absent', () => {
    expect(recurringTarget(rows, 'UTC', Date.parse('2026-10-04T23:00Z'))?.temperature).toBe(68)
    expect(recurringTarget([], 'UTC', Date.now())).toBeNull()
  })

  it('reuses unchanged weekly occurrences across minutes and recomputes only a due row', () => {
    const parse = vi.mocked(cronParser.parseExpression)
    parse.mockClear()
    const cache: RecurringOccurrenceCache = new Map()
    try {
      const start = Date.parse('2026-09-29T01:00Z')
      expect(recurringTarget(rows, 'UTC', start, cache)?.temperature).toBe(75)
      expect(parse).toHaveBeenCalledTimes(2)
      expect(recurringTarget(rows, 'UTC', start + 60_000, cache)?.temperature).toBe(75)
      expect(parse).toHaveBeenCalledTimes(2)
      expect(recurringTarget(rows, 'UTC', Date.parse('2026-09-29T02:00Z'), cache)?.temperature).toBe(68)
      expect(parse).toHaveBeenCalledTimes(3)
      // A setpoint edit changes the target without recalculating its clock.
      expect(recurringTarget([{ ...rows[1], temperature: 70 }], 'UTC', Date.parse('2026-09-29T02:01Z'), cache)?.temperature).toBe(70)
      expect(parse).toHaveBeenCalledTimes(3)
      expect(cache.size).toBe(1) // deleted/disabled schedules do not accumulate
    }
    finally { parse.mockClear() }
  })

  it('invalidates cached occurrences on clock rollback, timezone and time edits', () => {
    const cache: RecurringOccurrenceCache = new Map()
    const now = Date.parse('2026-09-29T03:00Z')
    recurringTarget(rows, 'UTC', now, cache)
    expect(recurringTarget(rows, 'UTC', now - 2 * 86_400_000, cache)).toEqual(recurringTarget(rows, 'UTC', now - 2 * 86_400_000))
    expect(recurringTarget(rows, 'America/Los_Angeles', now, cache)).toEqual(recurringTarget(rows, 'America/Los_Angeles', now))
    const edited = [{ ...rows[0], time: '23:30' }, rows[1]]
    expect(recurringTarget(edited, 'America/Los_Angeles', now, cache)).toEqual(recurringTarget(edited, 'America/Los_Angeles', now))
    expect(cache.size).toBe(2)
  })

  it('keeps cached spring-gap and fall-fold boundaries identical to fresh resolution', () => {
    for (const [time, moments] of [
      ['02:30', ['2026-03-08T07:29Z', '2026-03-08T07:30Z', '2026-03-15T07:00Z']],
      ['01:30', ['2026-11-01T05:29Z', '2026-11-01T05:30Z', '2026-11-01T06:30Z']],
    ] as const) {
      const cache: RecurringOccurrenceCache = new Map()
      const schedules: WeeklyTarget[] = [{ id: 'dst', dayOfWeek: 'sunday', time, temperature: 68 }]
      for (const moment of moments) {
        const now = Date.parse(moment)
        expect(recurringTarget(schedules, 'America/New_York', now, cache)).toEqual(recurringTarget(schedules, 'America/New_York', now))
      }
    }
  })

  it('matches forward cron execution for a schedule inside the missing spring hour', () => {
    const gap: WeeklyTarget[] = [
      { id: 'before', dayOfWeek: 'sunday', time: '01:00', temperature: 75 },
      { id: 'gap', dayOfWeek: 'sunday', time: '02:30', temperature: 68 },
    ]
    expect(recurringTarget(gap, 'America/New_York', Date.parse('2026-03-08T07:29Z'))?.temperature).toBe(75)
    const shifted = recurringTarget(gap, 'America/New_York', Date.parse('2026-03-08T07:30Z'))
    expect(shifted?.temperature).toBe(68)
    expect(shifted?.startsAt).toBe(Date.parse('2026-03-08T07:30Z'))
  })

  it('does not replay the repeated fall hour as a second occurrence', () => {
    const fall: WeeklyTarget[] = [{ id: 'fall', dayOfWeek: 'sunday', time: '01:30', temperature: 68 }]
    for (const time of ['2026-11-01T05:30Z', '2026-11-01T06:30Z']) {
      expect(recurringTarget(fall, 'America/New_York', Date.parse(time))?.startsAt).toBe(Date.parse('2026-11-01T05:30Z'))
    }
  })

  it('resolves spring-forward using the scheduler cron semantics', () => {
    const spring: WeeklyTarget[] = [{ id: 'spring', dayOfWeek: 'sunday', time: '03:30', temperature: 68 }]
    const target = recurringTarget(spring, 'America/New_York', Date.parse('2026-03-08T07:30Z'))
    expect(target?.startsAt).toBe(Date.parse('2026-03-08T07:30Z'))
  })
})

describe('current run-once target', () => {
  const session = {
    id: 1,
    startedAt: new Date('2026-09-28T22:00Z'),
    expiresAt: new Date('2026-09-29T07:00Z'),
    setPoints: [
      { time: '22:15', temperature: 75 },
      { time: '23:00', temperature: 72 },
      { time: '02:00', temperature: 68 },
    ],
  }

  it('uses the first point immediately, even when its label is later', () => {
    expect(sessionTarget(session, 'UTC', Date.parse('2026-09-28T22:00Z'))?.temperature).toBe(75)
  })

  it('resumes at the current point rather than shifting or replaying the curve', () => {
    expect(sessionTarget(session, 'UTC', Date.parse('2026-09-29T03:00Z'))?.temperature).toBe(68)
    expect(sessionTarget(session, 'UTC', Date.parse('2026-09-28T23:00Z'))?.temperature).toBe(72)
  })

  it('does not activate future or expired sessions', () => {
    expect(sessionTarget(session, 'UTC', Date.parse('2026-09-28T21:00Z'))).toBeNull()
    expect(sessionTarget(session, 'UTC', Date.parse('2026-09-29T07:00Z'))).toBeNull()
  })
})

describe('alarmTemperatureTargets', () => {
  // Monday 2026-09-28, UTC.
  const at = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 8, 28, hh, mm, ss)
  // 07:40, 60 s of vibration: the span ends 07:41 + 15 min = 07:56.
  const alarm = { id: 'alarm:7', dayOfWeek: 'monday' as const, time: '07:40', temperature: 95, wakeWindow: 0, duration: 60 }

  it('asks for the alarm temperature from 30 minutes before the alarm to 15 minutes after it ends', () => {
    expect(alarmTemperatureTargets([alarm], 'UTC', at(7, 9))).toEqual([])
    expect(alarmTemperatureTargets([alarm], 'UTC', at(7, 10))).toEqual([{
      id: 'alarm:7', source: 'schedule', temperature: 95,
      startsAt: at(7, 10), expiresAt: at(7, 56), createdAt: at(7, 10), priority: 1,
    }])
    expect(alarmTemperatureTargets([alarm], 'UTC', at(7, 40))).toHaveLength(1)
    expect(alarmTemperatureTargets([alarm], 'UTC', at(7, 55, 59))).toHaveLength(1)
    // Then the schedule applies again; next week's alarm is far off.
    expect(alarmTemperatureTargets([alarm], 'UTC', at(7, 56))).toEqual([])
    expect(alarmTemperatureTargets([alarm], 'UTC', at(14, 0))).toEqual([])
  })

  it('starts with the wake window when that is longer', () => {
    expect(alarmTemperatureTargets([{ ...alarm, wakeWindow: 45 }], 'UTC', at(6, 55))[0].startsAt).toBe(at(6, 55))
    expect(alarmTemperatureTargets([{ ...alarm, wakeWindow: 45 }], 'UTC', at(6, 54))).toEqual([])
    expect(alarmTemperatureTargets([{ ...alarm, wakeWindow: 20 }], 'UTC', at(7, 10))[0].startsAt).toBe(at(7, 10))
  })

  it('holds longer after a longer vibration', () => {
    expect(alarmTemperatureTargets([{ ...alarm, duration: 180 }], 'UTC', at(7, 10))[0].expiresAt).toBe(at(7, 58))
  })

  it('warms across midnight for an alarm just after it', () => {
    const early = { ...alarm, dayOfWeek: 'tuesday' as const, time: '00:10' }
    const [target] = alarmTemperatureTargets([early], 'UTC', at(23, 45))
    expect(target.startsAt).toBe(at(23, 40))
    expect(target.expiresAt).toBe(Date.UTC(2026, 8, 29, 0, 26))
  })

  it('caches each alarm\'s occurrence until its span ends, and drops alarms that are gone', () => {
    const cache = new Map<string, number>()
    alarmTemperatureTargets([alarm], 'UTC', at(7, 20), cache)
    expect([...cache.values()]).toEqual([at(7, 40)])
    alarmTemperatureTargets([alarm], 'UTC', at(7, 50), cache)
    expect([...cache.values()]).toEqual([at(7, 40)])
    alarmTemperatureTargets([alarm], 'UTC', at(7, 56), cache)
    expect([...cache.values()]).toEqual([Date.UTC(2026, 9, 5, 7, 40)])
    alarmTemperatureTargets([], 'UTC', at(7, 56), cache)
    expect(cache.size).toBe(0)
  })
})

describe('alarmWarmupMinutes', () => {
  it('is 30 minutes, or the wake window when longer', () => {
    expect(ALARM_WARMUP_MIN).toBe(30)
    expect(ALARM_HOLD_AFTER_MIN).toBe(15)
    expect(alarmWarmupMinutes(0)).toBe(30)
    expect(alarmWarmupMinutes(30)).toBe(30)
    expect(alarmWarmupMinutes(45)).toBe(45)
  })
})
