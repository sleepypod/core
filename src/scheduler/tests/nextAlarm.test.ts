import { describe, expect, it } from 'vitest'
import { nextAlarm, type AlarmRow } from '../nextAlarm'

const TZ = 'America/New_York'
// Saturday 2026-11-07, 08:00 EST (UTC-5).
const SAT_8AM = Date.parse('2026-11-07T13:00:00Z')

const row = (id: number, dayOfWeek: AlarmRow['dayOfWeek'], time: string, over: Partial<AlarmRow> = {}): AlarmRow =>
  ({ id, side: 'left', dayOfWeek, time, wakeWindow: 0, enabled: true, ...over })

describe('nextAlarm', () => {
  it('is the soonest enabled alarm after now, in the device timezone', () => {
    const rows = [row(1, 'saturday', '07:40'), row(2, 'sunday', '09:30', { wakeWindow: 20 }), row(3, 'saturday', '22:00', { enabled: false })]
    // Saturday's 07:40 has passed; Sunday 09:30 EST is 14:30 UTC.
    expect(nextAlarm(rows, 'left', SAT_8AM, TZ)).toEqual({ id: 2, at: Date.parse('2026-11-08T14:30:00Z'), dayOfWeek: 'sunday', time: '09:30', wakeWindow: 20 })
  })

  it('includes a later alarm the same day', () => {
    expect(nextAlarm([row(1, 'saturday', '09:30')], 'left', SAT_8AM, TZ)?.at).toBe(Date.parse('2026-11-07T14:30:00Z'))
  })

  it('wraps to next week when the only alarm today has passed', () => {
    expect(nextAlarm([row(1, 'saturday', '07:40')], 'left', SAT_8AM, TZ)?.at).toBe(Date.parse('2026-11-14T12:40:00Z'))
  })

  it('follows daylight saving: a Monday alarm across the spring change keeps its wall time', () => {
    // Sunday 2027-03-14 springs forward; Monday 07:00 is then EDT (UTC-4).
    const satBefore = Date.parse('2027-03-13T13:00:00Z')
    expect(nextAlarm([row(1, 'monday', '07:00')], 'left', satBefore, TZ)?.at).toBe(Date.parse('2027-03-15T11:00:00Z'))
  })

  it('only counts the asked side', () => {
    expect(nextAlarm([row(1, 'sunday', '09:30', { side: 'right' })], 'left', SAT_8AM, TZ)).toBeNull()
  })

  it('has none for a side whose alarms do not run', () => {
    const rows = [row(1, 'sunday', '09:30', { side: 'right' })]
    expect(nextAlarm(rows, 'right', SAT_8AM, TZ, { bedMode: 'solo-left' })).toBeNull()
    expect(nextAlarm(rows, 'right', SAT_8AM, TZ, { right: { awayMode: true } })).toBeNull()
    expect(nextAlarm(rows, 'right', SAT_8AM, TZ, { bedMode: 'two' })?.id).toBe(1)
  })

  it('skips malformed rows', () => {
    expect(nextAlarm([row(1, 'sunday', 'bad'), row(2, 'funday' as never, '09:30')], 'left', SAT_8AM, TZ)).toBeNull()
  })
})
