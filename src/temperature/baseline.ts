import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { weeklyWindow, weeklyZone, type WeeklyZone } from '@/src/scheduler/occurrences'
import { timeToDate } from '@/src/scheduler/timeUtils'
import type { TemperatureRequest } from './controller'

export interface WeeklyTarget {
  id: string
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
}

export type RecurringOccurrenceCache = Map<string, { startsAt: number, expiresAt: number }>

/**
 * Weekly occurrences follow the scheduler's cron and timezone semantics
 * (`src/scheduler/occurrences.ts`), computed arithmetically: cron-parser with
 * a `tz` option took ~0.5 s per row on the pod, which with a few hundred rows
 * blocked the event loop for over a minute on the first tick after start.
 */
export function recurringTarget(rows: WeeklyTarget[], timezone: string, now: number, cache: RecurringOccurrenceCache = new Map()): TemperatureRequest | null {
  const activeKeys = new Set<string>()
  let latest: TemperatureRequest | null = null
  let zone: WeeklyZone | null = null
  for (const row of rows) {
    const key = JSON.stringify([timezone, row.dayOfWeek, row.time])
    activeKeys.add(key)
    let occurrence = cache.get(key)
    if (!occurrence || now < occurrence.startsAt || now >= occurrence.expiresAt) {
      const [hour, minute] = row.time.split(':').map(Number)
      // Cache each weekly interval, not just the winning target for one minute:
      // recomputing hundreds of unchanged rows every minute adds up on a Pod CPU.
      zone ??= weeklyZone(now, timezone)
      occurrence = weeklyWindow(zone, DAYS_OF_WEEK.indexOf(row.dayOfWeek), hour, minute, now)
      cache.set(key, occurrence)
    }
    const { startsAt, expiresAt } = occurrence
    const candidate: TemperatureRequest = {
      id: row.id, source: 'schedule', temperature: row.temperature,
      startsAt, expiresAt, createdAt: startsAt, priority: 0,
    }
    if (!latest || startsAt > latest.startsAt || (startsAt === latest.startsAt && row.id < latest.id)) latest = candidate
  }
  for (const key of cache.keys()) {
    if (!activeKeys.has(key)) cache.delete(key)
  }
  return latest
}

export interface SessionTarget {
  id: number
  startedAt: Date
  expiresAt: Date
  setPoints: Array<{ time: string, temperature: number }>
}

/** The first point applies immediately; subsequent points keep the session's original clock. */
export function sessionTarget(session: SessionTarget, timezone: string, now: number): TemperatureRequest | null {
  if (session.startedAt.getTime() > now || session.expiresAt.getTime() <= now || !session.setPoints.length) return null
  let temperature = session.setPoints[0].temperature
  let lastPointAt = session.startedAt.getTime()
  for (const point of session.setPoints.slice(1)) {
    const at = timeToDate(point.time, timezone, session.startedAt).getTime()
    if (at <= now && at >= lastPointAt) {
      temperature = point.temperature
      lastPointAt = at
    }
  }
  return {
    id: `run-once:${session.id}`, source: 'run-once', temperature,
    startsAt: session.startedAt.getTime(), expiresAt: session.expiresAt.getTime(),
    createdAt: session.startedAt.getTime(), priority: 0,
  }
}
