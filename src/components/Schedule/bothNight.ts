import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { calendarNightPoints, nextCalendarTemperature } from '@/src/lib/calendarTemperature'
import { buildTimeline } from './CurveChart'

export interface TempRow {
  dayOfWeek: string
  time: string
  temperature: number
  enabled: boolean
}

const MINUTE = 60_000

/** Evening rows plus the following calendar morning, with explicit display offsets. */
export const nightSetPoints = calendarNightPoints

/** Local midnight of the next `day` on or after `now` (today counts). */
export function nightDate(day: DayOfWeek, now: Date): Date {
  const offset = (DAYS_OF_WEEK.indexOf(day) - now.getDay() + 7) % 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
}

/** Absolute start/end of a night's curve, or null when it has no set points. */
export function nightWindow(setPoints: Array<{ time: string, temperature: number, dayOffset?: 0 | 1 }>, midnight: Date): { start: Date, end: Date } | null {
  const tl = buildTimeline(setPoints)
  if (tl.length === 0) return null
  const at = (m: number) => new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, m)
  return { start: at(tl[0].minutes), end: at(tl[tl.length - 1].minutes) }
}

export const nextSetPoint = nextCalendarTemperature

/** "5h 21m" / "45m". */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${m}m` : `${m}m`
}

/** "Sep 28 → 29", or "Sep 30 → Oct 1" across a month boundary. */
export function formatNightDates(midnight: Date): string {
  const next = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() + 1)
  const month = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' })
  const tail = next.getMonth() === midnight.getMonth() ? `${next.getDate()}` : `${month(next)} ${next.getDate()}`
  return `${month(midnight)} ${midnight.getDate()} → ${tail}`
}
