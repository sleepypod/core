import { describe, expect, it } from 'vitest'
import { recurringTarget, sessionTarget, type WeeklyTarget } from '../baseline'

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
