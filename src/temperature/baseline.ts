import { parseExpression } from 'cron-parser'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import { timeToDate } from '@/src/scheduler/timeUtils'
import type { TemperatureRequest } from './controller'

export interface WeeklyTarget {
  id: string
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
}

export type RecurringOccurrenceCache = Map<string, { startsAt: number, expiresAt: number }>

/** Use node-schedule's cron parser and timezone semantics for both engines. */
export function recurringTarget(rows: WeeklyTarget[], timezone: string, now: number, cache: RecurringOccurrenceCache = new Map()): TemperatureRequest | null {
  const activeKeys = new Set<string>()
  let latest: TemperatureRequest | null = null
  for (const row of rows) {
    const key = JSON.stringify([timezone, row.dayOfWeek, row.time])
    activeKeys.add(key)
    let occurrence = cache.get(key)
    if (!occurrence || now < occurrence.startsAt || now >= occurrence.expiresAt) {
      const [hour, minute] = row.time.split(':').map(Number)
      const cron = `${minute} ${hour} * * ${DAYS_OF_WEEK.indexOf(row.dayOfWeek)}`
      // Forward iteration matches node-schedule through missing/repeated DST
      // hours. cron-parser.prev() is not the inverse of next() in a spring gap.
      // Cache each weekly interval, not just the winning target for one minute:
      // recomputing hundreds of unchanged cron rows can saturate a Pod CPU.
      const occurrences = parseExpression(cron, { currentDate: new Date(now - 15 * 86_400_000), tz: timezone })
      let startsAt = occurrences.next().getTime()
      let expiresAt = occurrences.next().getTime()
      while (expiresAt <= now) {
        startsAt = expiresAt
        expiresAt = occurrences.next().getTime()
      }
      occurrence = { startsAt, expiresAt }
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
