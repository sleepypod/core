import { DAYS_OF_WEEK, hhmmToMinutes, type DayOfWeek } from './scheduleTime'

export interface CalendarTemperature {
  dayOfWeek: string
  time: string
  temperature: number
  enabled: boolean
}

export interface NightTemperature {
  time: string
  temperature: number
  dayOffset: 0 | 1
}

/** Display grouping only: scheduler rows always retain their actual calendar weekday. */
export function calendarNightPoints(rows: CalendarTemperature[] | undefined, day: DayOfWeek): NightTemperature[] {
  const nextDay = DAYS_OF_WEEK[(DAYS_OF_WEEK.indexOf(day) + 1) % DAYS_OF_WEEK.length]
  return (rows ?? []).flatMap((row): NightTemperature[] => {
    if (!row.enabled || !validClock(row.time)) return []
    const morning = hhmmToMinutes(row.time) < 12 * 60
    if (row.dayOfWeek !== (morning ? nextDay : day)) return []
    return [{ time: row.time, temperature: row.temperature, dayOffset: morning ? 1 : 0 }]
  }).sort((first, second) => nightMinutes(first) - nightMinutes(second))
}

export function nightMinutes(point: NightTemperature): number {
  return hhmmToMinutes(point.time) + point.dayOffset * 24 * 60
}

function validClock(time: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(time)
}

/** Local calendar occurrence: ordinary spring gaps shift forward; midnight gaps are skipped. */
export function nextCalendarOccurrence(day: string, time: string, now: Date): Date | null {
  const dayIndex = DAYS_OF_WEEK.findIndex(value => value === day)
  if (dayIndex < 0 || !validClock(time)) return null
  const minutes = hhmmToMinutes(time)
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  const offset = (dayIndex - now.getDay() + 7) % 7
  for (let week = 0; week < 3; week++) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + week * 7, hour, minute)
    if (at > now && (hour !== 0 || at.getHours() === 0)) return at
  }
  return null
}

/** Next enabled calendar row; never move an early-morning row to the next day. */
export function nextCalendarTemperature(rows: CalendarTemperature[] | undefined, now: Date): { at: Date, time: string, temperature: number } | null {
  let next: { at: Date, time: string, temperature: number } | null = null
  for (const row of rows ?? []) {
    if (!row.enabled) continue
    const at = nextCalendarOccurrence(row.dayOfWeek, row.time, now)
    if (at && (!next || at < next.at)) next = { at, time: row.time, temperature: row.temperature }
  }
  return next
}
