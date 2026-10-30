import { createHash } from 'node:crypto'
import { DAYS_OF_WEEK, powerOffDay, type DayOfWeek } from '@/src/lib/scheduleTime'
import { expandOccurrences, type OccurrenceSource } from '@/src/scheduler/occurrences'
import type { RoutineWindow } from './policy'

interface PowerRow { id: number, dayOfWeek: DayOfWeek, onTime: string, offTime: string, offDayOffset?: number, onTemperature: number }
interface TargetRow { id: number, dayOfWeek: DayOfWeek, time: string, temperature: number }
interface AlarmRow { id: number, dayOfWeek: DayOfWeek, time: string }
export interface ComfortSchedules { powers: PowerRow[], targets: TargetRow[], alarms: AlarmRow[], timezone: string, source?: string }
const DAY_MS = 86_400_000
const clockPattern = /^([01]\d|2[0-3]):[0-5]\d$/

function job(id: string, type: string, day: DayOfWeek, time: string, temperature?: number): OccurrenceSource {
  if (!clockPattern.test(time) || !DAYS_OF_WEEK.includes(day)) throw new Error('Invalid comfort schedule')
  const [hour, minute] = time.split(':').map(Number)
  return { id, type, schedule: `${minute} ${hour} * * ${DAYS_OF_WEEK.indexOf(day)}`, metadata: { targetTemperature: temperature } }
}

/** Use the scheduler's actual weekday/DST events, never invent a next-day OFF. */
export function comfortRoutineAt(schedules: ComfortSchedules, now: number): RoutineWindow | null {
  if (!Number.isSafeInteger(now)) return null
  const jobs: OccurrenceSource[] = []
  try {
    jobs.push(...scheduleJobs(schedules))
    const events = expandOccurrences(jobs, new Date(now - 2 * DAY_MS), new Date(now + 2 * DAY_MS), schedules.timezone)
    const candidates = events.filter(event => event.type === 'start' && event.at <= now).flatMap((start) => {
      const end = events.find(event => event.type === 'end' && event.at > start.at)
      if (!end || end.at <= now || end.at - start.at > 26 * 3_600_000) return []
      return [{ start, end }]
    })
    // Overlapping starts have no unambiguous personal-learning session.
    if (candidates.length !== 1) return null
    const { start, end } = candidates[0]
    const targets = events.filter(event => (event.type === 'target' || event.type === 'start')
      && event.at >= start.at && event.at <= now)
      .sort((first, second) => second.at - first.at || first.id.localeCompare(second.id))
    const target = targets[0]
    if (!target || target.targetTempF === null || target.targetTempF < 55 || target.targetTempF > 110) return null
    const alarm = events.find(event => event.type === 'alarm' && event.at > start.at && event.at <= end.at)
    const session = `${start.id}:${start.at}`
    const revision = comfortScheduleRevision(schedules)
    if (!revision) return null
    const changes: { id: string, at: number, temperatureF: number }[] = []
    for (const event of events.filter(event => event.type === 'target' && event.at > start.at && event.at < end.at)) {
      if (event.targetTempF === null || !Number.isFinite(event.targetTempF) || event.targetTempF < 55 || event.targetTempF > 110) return null
      changes.push({ id: event.id, at: event.at, temperatureF: event.targetTempF })
    }
    if (start.targetTempF === null) return null
    return { phases: { revision, startF: start.targetTempF, changes }, session, segment: `${session}:${target.id}:${target.at}`, start: start.at, end: end.at, baselineF: target.targetTempF, alarmAt: alarm?.at ?? null }
  }
  catch { return null }
}

function scheduleJobs(schedules: ComfortSchedules): OccurrenceSource[] {
  const jobs: OccurrenceSource[] = []
  for (const row of schedules.powers) {
    if (row.onTime === row.offTime || !Number.isFinite(row.onTemperature)) throw new Error('Invalid comfort schedule')
    jobs.push(job(`power:${row.id}`, 'start', row.dayOfWeek, row.onTime, row.onTemperature))
    jobs.push(job(`end:${row.id}`, 'end', powerOffDay(row), row.offTime))
  }
  for (const row of schedules.targets) {
    if (!Number.isFinite(row.temperature)) throw new Error('Invalid comfort schedule')
    jobs.push(job(`temperature:${row.id}`, 'target', row.dayOfWeek, row.time, row.temperature))
  }
  for (const row of schedules.alarms) jobs.push(job(`alarm:${row.id}`, 'alarm', row.dayOfWeek, row.time))
  return jobs
}

/** Bind qualification to every enabled weekly phase, including when no routine is active. */
export function comfortScheduleRevision(schedules: ComfortSchedules): string | null {
  try {
    const jobs = scheduleJobs(schedules)
    if (!schedules.powers.length) return null
    return createHash('sha256').update(JSON.stringify([schedules.timezone, schedules.source ?? null, jobs.sort((first, second) => first.id.localeCompare(second.id))])).digest('hex')
  }
  catch { return null }
}
