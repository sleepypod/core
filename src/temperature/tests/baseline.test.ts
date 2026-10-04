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

  it('matches cron-parser across spring and fall transitions in several zones', () => {
    // The scheduler's arithmetic path must keep node-schedule/cron-parser
    // semantics for the boundary the controller derives from it. Kept small:
    // cron-parser with tz is slow enough that a wide grid times out in CI.
    const dows = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
    const sample = (iso: string, dayOfWeek: WeeklyTarget['dayOfWeek'], time: string, tz: string) => {
      const now = Date.parse(iso)
      const got = recurringTarget([{ id: 'x', dayOfWeek, time, temperature: 70 }], tz, now)
      if (!got) throw new Error(`no target for ${dayOfWeek} ${time} ${tz} at ${iso}`)
      const [hour, minute] = time.split(':').map(Number)
      const it = parseExpression(`${minute} ${hour} * * ${dows.indexOf(dayOfWeek)}`, { currentDate: new Date(now - 15 * 86_400_000), tz })
      let startsAt = it.next().getTime()
      let expiresAt = it.next().getTime()
      while (expiresAt <= now) {
        startsAt = expiresAt
        expiresAt = it.next().getTime()
      }
      expect({ tz, iso, dayOfWeek, time, startsAt: got.startsAt, expiresAt: got.expiresAt }).toEqual({ tz, iso, dayOfWeek, time, startsAt, expiresAt })
    }
    const cases: Array<[string, string[]]> = [
      ['America/New_York', ['2026-03-08T06:59Z', '2026-03-08T07:30Z', '2026-11-01T05:30Z', '2026-11-01T06:30Z']],
      ['Europe/Berlin', ['2026-03-29T00:59Z', '2026-03-29T01:30Z', '2026-10-25T00:30Z', '2026-10-25T01:30Z']],
      ['Australia/Sydney', ['2026-04-04T16:30Z', '2026-10-03T16:30Z']],
    ]
    for (const [tz, instants] of cases) {
      for (const iso of instants) {
        for (const dayOfWeek of ['sunday', 'saturday'] as const) {
          for (const time of ['01:30', '02:30', '03:30']) sample(iso, dayOfWeek, time, tz)
        }
      }
    }
  }, 30_000)

  it('shifts a row inside a midnight spring gap forward, never onto the previous evening', () => {
    // America/Havana jumps 23:59:59 → 01:00 on 2026-03-08. cron-parser 4.9
    // drops this firing entirely; the controller instead fires it once at the
    // first instant past the gap, matching ordinary gaps such as New York 02:30.
    const rows: WeeklyTarget[] = [
      { id: 'sat', dayOfWeek: 'saturday', time: '22:00', temperature: 75 },
      { id: 'sun', dayOfWeek: 'sunday', time: '00:30', temperature: 68 },
    ]
    const gapEnd = Date.parse('2026-03-08T05:30Z') // 00:30 CST would be 05:30Z; it fires there, as 01:30 CDT
    expect(recurringTarget(rows, 'America/Havana', gapEnd - 60_000)?.id).toBe('sat')
    const shifted = recurringTarget(rows, 'America/Havana', gapEnd)
    expect(shifted?.id).toBe('sun')
    expect(shifted?.startsAt).toBe(gapEnd)
    expect(shifted?.expiresAt).toBe(Date.parse('2026-03-15T04:30Z')) // next Sunday 00:30 CDT
    // A week later the Saturday row wins again until Sunday 00:30 CDT.
    expect(recurringTarget(rows, 'America/Havana', Date.parse('2026-03-15T04:29Z'))?.id).toBe('sat')
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
