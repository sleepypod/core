import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { buildTimeline } from './CurveChart'

export interface TempRow {
  dayOfWeek: string
  time: string
  temperature: number
  enabled: boolean
}

const MINUTE = 60_000

/** Enabled set points saved under `day` (post-midnight points belong to the night that started on `day`). */
export function nightSetPoints(temps: TempRow[] | undefined, day: DayOfWeek): Array<{ time: string, temperature: number }> {
  return (temps ?? [])
    .filter(t => t.enabled && t.dayOfWeek === day)
    .map(t => ({ time: t.time, temperature: t.temperature }))
}

/** Local midnight of the next `day` on or after `now` (today counts). */
export function nightDate(day: DayOfWeek, now: Date): Date {
  const offset = (DAYS_OF_WEEK.indexOf(day) - now.getDay() + 7) % 7
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
}

/** Absolute start/end of a night's curve, or null when it has no set points. */
export function nightWindow(setPoints: Array<{ time: string, temperature: number }>, midnight: Date): { start: Date, end: Date } | null {
  const tl = buildTimeline(setPoints)
  if (tl.length === 0) return null
  const at = (m: number) => new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, m)
  return { start: at(tl[0].minutes), end: at(tl[tl.length - 1].minutes) }
}

/**
 * The soonest enabled set point after `now`, placing overnight points on the
 * morning after the day they're saved under. Starts from yesterday so tonight's
 * post-midnight points count.
 */
export function nextSetPoint(temps: TempRow[] | undefined, now: Date): { at: Date, time: string, temperature: number } | null {
  let best: { at: Date, time: string, temperature: number } | null = null
  for (let offset = -1; offset < 8; offset++) {
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
    const day = DAYS_OF_WEEK[midnight.getDay()]
    for (const p of buildTimeline(nightSetPoints(temps, day))) {
      const at = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), 0, p.minutes)
      if (at > now && (!best || at < best.at)) best = { at, time: p.item.time, temperature: p.temperature }
    }
  }
  return best
}

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
