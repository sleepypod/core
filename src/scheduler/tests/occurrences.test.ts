// @vitest-environment node
import { describe, expect, it } from 'vitest'
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
})
