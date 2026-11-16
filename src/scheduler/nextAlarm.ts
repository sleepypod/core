/**
 * When a side's alarm next goes off, for consumers outside the scheduler
 * (the MQTT bridge). Uses the scheduler's own weekly expansion, so daylight
 * saving and the device timezone resolve exactly as the alarm job fires.
 */
import { activeSleeperSides, type BedState } from '@/src/lib/singleSleeper'
import { weeklyWindow, weeklyZone } from './occurrences'

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

export interface AlarmRow {
  id: number
  side: 'left' | 'right'
  dayOfWeek: typeof WEEKDAYS[number]
  /** HH:mm in the device timezone. */
  time: string
  wakeWindow: number
  enabled: boolean
}

export interface NextAlarm {
  id: number
  /** Epoch ms of the set time. */
  at: number
  dayOfWeek: AlarmRow['dayOfWeek']
  time: string
  /** Minutes before `at` in which movement fires it early; 0 = off. */
  wakeWindow: number
}

/**
 * The next enabled alarm for `side` after `now`, or null when it has none —
 * including when the side's alarms don't run (it is away, or the unused side
 * of a solo bed).
 */
export function nextAlarm(rows: AlarmRow[], side: AlarmRow['side'], now: number, timezone: string, modes?: BedState | null): NextAlarm | null {
  if (!activeSleeperSides(modes).includes(side)) return null
  let zone: ReturnType<typeof weeklyZone> | null = null
  let next: NextAlarm | null = null
  for (const row of rows) {
    if (row.side !== side || !row.enabled) continue
    const [hour, minute] = row.time.split(':').map(Number)
    const weekday = WEEKDAYS.indexOf(row.dayOfWeek)
    if (weekday < 0 || !Number.isInteger(hour) || !Number.isInteger(minute)) continue
    zone ??= weeklyZone(now, timezone)
    const at = weeklyWindow(zone, weekday, hour, minute, now).expiresAt
    if (!Number.isFinite(at)) continue
    if (!next || at < next.at) next = { id: row.id, at, dayOfWeek: row.dayOfWeek, time: row.time, wakeWindow: row.wakeWindow }
  }
  return next
}
