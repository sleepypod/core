import { describe, expect, it } from 'vitest'
import { parseExpression } from 'cron-parser'
import { recurringTarget, sessionTarget, type WeeklyTarget, type RecurringOccurrenceCache } from '../baseline'

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
    const cache: RecurringOccurrenceCache = new Map()
    const entry = (row: WeeklyTarget) => cache.get(JSON.stringify(['UTC', row.dayOfWeek, row.time]))
    const start = Date.parse('2026-09-29T01:00Z')
    expect(recurringTarget(rows, 'UTC', start, cache)?.temperature).toBe(75)
    expect(cache.size).toBe(2)
    const [bedtime, overnight] = [entry(rows[0]), entry(rows[1])]
    expect(recurringTarget(rows, 'UTC', start + 60_000, cache)?.temperature).toBe(75)
    // Same objects: nothing was recomputed for an unchanged minute.
    expect(entry(rows[0])).toBe(bedtime)
    expect(entry(rows[1])).toBe(overnight)
    expect(recurringTarget(rows, 'UTC', Date.parse('2026-09-29T02:00Z'), cache)?.temperature).toBe(68)
    // Only the row that just fired rolled to its new weekly interval.
    expect(entry(rows[0])).toBe(bedtime)
    expect(entry(rows[1])).not.toBe(overnight)
    expect(entry(rows[1])).toEqual({ startsAt: Date.parse('2026-09-29T02:00Z'), expiresAt: Date.parse('2026-10-06T02:00Z') })
    // A setpoint edit changes the target without recalculating its clock.
    const rolled = entry(rows[1])
    expect(recurringTarget([{ ...rows[1], temperature: 70 }], 'UTC', Date.parse('2026-09-29T02:01Z'), cache)?.temperature).toBe(70)
    expect(entry(rows[1])).toBe(rolled)
    expect(cache.size).toBe(1) // deleted/disabled schedules do not accumulate
  })

  it('matches cron-parser for every weekday and hour across a year of DST transitions', () => {
    // The scheduler's arithmetic path must keep node-schedule/cron-parser
    // semantics for the boundary the controller derives from it.
    const sample = (iso: string, dayOfWeek: WeeklyTarget['dayOfWeek'], time: string, tz: string) => {
      const now = Date.parse(iso)
      const got = recurringTarget([{ id: 'x', dayOfWeek, time, temperature: 70 }], tz, now)
      if (!got) throw new Error(`no target for ${dayOfWeek} ${time} ${tz} at ${iso}`)
      const [hour, minute] = time.split(':').map(Number)
      const dows = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
      const it = parseExpression(`${minute} ${hour} * * ${dows.indexOf(dayOfWeek)}`, { currentDate: new Date(now - 15 * 86_400_000), tz })
      let startsAt = it.next().getTime()
      let expiresAt = it.next().getTime()
      while (expiresAt <= now) {
        startsAt = expiresAt
        expiresAt = it.next().getTime()
      }
      expect({ startsAt: got.startsAt, expiresAt: got.expiresAt }).toEqual({ startsAt, expiresAt })
    }
    for (const tz of ['America/New_York', 'Europe/Berlin', 'Australia/Sydney', 'UTC']) {
      for (const iso of ['2026-03-08T06:59Z', '2026-03-08T07:30Z', '2026-03-29T00:59Z', '2026-04-05T15:59Z', '2026-10-04T16:00Z', '2026-10-25T01:30Z', '2026-11-01T05:30Z', '2026-11-01T06:30Z']) {
        for (const dayOfWeek of ['sunday', 'wednesday', 'saturday'] as const) {
          for (const time of ['00:00', '01:30', '02:30', '03:30', '23:59']) sample(iso, dayOfWeek, time, tz)
        }
      }
    }
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
