// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseExpression } from 'cron-parser'
import { expandOccurrences } from '../occurrences'

const TZ = 'America/Los_Angeles'
// Mon 2026-09-28 17:00 PDT
const from = new Date('2026-09-29T00:00:00Z')
const to = new Date(from.getTime() + 7 * 86_400_000)

describe('expandOccurrences', () => {
  it('expands a weekly cron into every firing in the window, not just the next one', () => {
    const occ = expandOccurrences([
      { id: 'temp-1', type: 'temperature', schedule: '15 23 * * 1,3,5', metadata: { side: 'left', targetTemperature: 80 } },
    ], from, to, TZ)
    expect(occ.map(o => new Date(o.at).toISOString())).toEqual([
      '2026-09-29T06:15:00.000Z', // Mon 11:15 PM PDT
      '2026-10-01T06:15:00.000Z', // Wed
      '2026-10-03T06:15:00.000Z', // Fri
    ])
    expect(occ[0]).toMatchObject({ id: 'temp-1', side: 'left', targetTempF: 80, brightness: null })
  })

  it('includes one-time jobs inside the window and drops the rest', () => {
    const occ = expandOccurrences([
      { id: 'in', type: 'away_mode', schedule: '2026-09-30T10:00:00.000Z', oneTime: true, metadata: { side: 'right' } },
      { id: 'out', type: 'away_mode', schedule: '2026-12-30T10:00:00.000Z', oneTime: true },
    ], from, to, TZ)
    expect(occ.map(o => o.id)).toEqual(['in'])
  })

  it('merges jobs in time order and skips unparseable schedules', () => {
    const occ = expandOccurrences([
      { id: 'led', type: 'led_brightness', schedule: '0 22 * * *', metadata: { brightness: 2 } },
      { id: 'bad', type: 'reboot', schedule: 'not a cron' },
      { id: 'reboot', type: 'reboot', schedule: '0 3 * * *' },
    ], from, new Date(from.getTime() + 86_400_000), TZ)
    expect(occ.map(o => o.id)).toEqual(['led', 'reboot'])
    expect(occ[0].brightness).toBe(2)
    expect(occ[1].side).toBeUndefined()
  })

  it('matches cron-parser for simple crons, across a DST change and in other zones', () => {
    const crons = ['15 23 * * 1,3,5', '30 1 * * *', '0 2 * * 0', '45 6 * * 6,0', '0 0 * * 7']
    for (const tz of [TZ, 'Europe/London', 'Asia/Kolkata', 'UTC']) {
      // US DST ends Nov 1 2026, UK Oct 25 2026.
      const a = new Date('2026-10-20T00:00:00Z')
      const b = new Date('2026-11-05T00:00:00Z')
      for (const schedule of crons) {
        const expected: number[] = []
        const it = parseExpression(schedule, { currentDate: new Date(a.getTime() - 1), endDate: b, tz })
        while (it.hasNext()) {
          const t = it.next().getTime()
          if (t >= b.getTime()) break
          expected.push(t)
        }
        expect(expandOccurrences([{ id: 'j', type: 'temperature', schedule }], a, b, tz).map(o => o.at), `${tz} ${schedule}`).toEqual(expected)
      }
    }
  }, 30_000)

  it('skips Havana midnight gaps in schedule previews', () => {
    const start = new Date('2026-03-08T00:00Z')
    const end = new Date('2026-03-09T00:00Z')
    expect(expandOccurrences([{ id: 'gap', type: 'temperature', schedule: '30 0 * * 0' }], start, end, 'America/Havana')).toEqual([])
  })

  it('expands a full schedule quickly', () => {
    const jobs = Array.from({ length: 400 }, (_, i) => ({ id: `t${i}`, type: 'temperature', schedule: `${i % 60} ${i % 24} * * ${i % 7}` }))
    const started = performance.now()
    const occ = expandOccurrences(jobs, from, new Date(from.getTime() + 9 * 86_400_000), TZ)
    expect(occ.length).toBeGreaterThan(400)
    expect(performance.now() - started).toBeLessThan(200)
  })
})
