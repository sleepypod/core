import { z } from 'zod'
import { alarmDigest, alarmHoldEnd, consistentAlarm, validAlarmOverride, type AlarmContext } from '@/src/alarms/model'
import { dateInTimeZone } from '@/src/lib/timeZoneDate'
import { DAYS_OF_WEEK, powerOffDay } from '@/src/lib/scheduleTime'
import { expandOccurrences, type OccurrenceSource } from '@/src/scheduler/occurrences'
import { alarmWarmupMinutes } from '@/src/temperature/baseline'
import { EXPERIMENT_MINIMUM_EXPOSURE_MS, EXPERIMENT_NIGHTS, EXPERIMENT_SCHEDULE_DAYS,
  experimentDateSchema, experimentScheduleSchema, type ExperimentSchedule, type ExperimentWindow } from './contract'

const DAY_MS = 86_400_000
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const powerSchema = z.object({
  id: z.number().int().positive(), dayOfWeek: z.enum(DAYS_OF_WEEK),
  onTime: clock, offTime: clock, offDayOffset: z.number().int().min(0).max(1).default(0),
  endAction: z.enum(['turn_off', 'maintain']), onTemperature: z.number().int().min(55).max(110),
})
export interface ExperimentScheduleSource {
  powers: z.input<typeof powerSchema>[]
  alarm: AlarmContext
}
type SkippedDate = ExperimentSchedule['skipped'][number]
interface WakeSpan { startsAt: number, endsAt: number, wake: NonNullable<ExperimentWindow['wake']>, consistent: boolean }

export class ExperimentScheduleError extends Error {}

function weeklyJob(id: string, type: string, weekday: number, time: string): OccurrenceSource {
  const [hour, minute] = time.split(':').map(Number)
  return { id, type, schedule: `${minute} ${hour} * * ${weekday}` }
}

/** Expand the same scheduler clocks and effective one-occurrence overrides without touching an alarm. */
function wakeSpans(context: AlarmContext, from: number, to: number, now: number): WakeSpan[] {
  const events = expandOccurrences(context.rows.map(row => weeklyJob(String(row.id), 'wake', DAYS_OF_WEEK.indexOf(row.dayOfWeek), row.time)),
    new Date(from), new Date(to), context.timeZone)
  const changed = validAlarmOverride(context, now)
  const grouped = new Map<number, Set<number>>()
  for (const event of events) {
    const group = grouped.get(event.at) ?? new Set<number>()
    group.add(Number(event.id))
    grouped.set(event.at, group)
  }
  return [...grouped].flatMap(([originalAt, ids]): WakeSpan[] => {
    const rows = context.rows.filter(row => ids.has(row.id))
    const override = changed?.originalAt === originalAt && alarmDigest(changed.ids) === alarmDigest(rows.map(row => row.id)) ? changed : null
    if (override?.at === null) return []
    const at = override?.at ?? originalAt
    const startsAt = at - Math.max(...rows.map(row => alarmWarmupMinutes(row.wakeWindow))) * 60_000
    return [{ startsAt, endsAt: alarmHoldEnd(at, rows),
      consistent: consistentAlarm({ rows, originalAt, at, skipped: false, token: '', source: override ? 'override' : 'routine' }),
      wake: { at, startsAt, temperatureF: rows[0].alarmTemperature, vibrationSeconds: rows[0].duration,
        source: override ? 'override' : 'routine' } }]
  }).sort((first, second) => first.startsAt - second.startsAt)
}

/** Select eight two-night periods from existing routines; missing nights never create new heating jobs. */
export function resolveExperimentSchedule(source: ExperimentScheduleSource, requestedDate: string, now: number): ExperimentSchedule {
  z.number().int().nonnegative().max(8_640_000_000_000_000).parse(now)
  const requestedFirstNightDate = experimentDateSchema.parse(requestedDate)
  const powers = z.array(powerSchema).min(1).max(128).parse(source.powers)
  if (!source.alarm.configured || !source.alarm.available || new Set(powers.map(row => row.id)).size !== powers.length)
    throw new ExperimentScheduleError('Your scheduled nights are unavailable. Review your routines first.')
  const from = Date.parse(requestedFirstNightDate) - 2 * DAY_MS
  const to = Date.parse(requestedFirstNightDate) + (EXPERIMENT_SCHEDULE_DAYS + 2) * DAY_MS
  const jobs = powers.flatMap(row => [
    weeklyJob(`start:${row.id}`, 'start', DAYS_OF_WEEK.indexOf(row.dayOfWeek), row.onTime),
    weeklyJob(`end:${row.id}`, 'end', DAYS_OF_WEEK.indexOf(powerOffDay(row)), row.offTime),
  ])
  const events = expandOccurrences(jobs, new Date(from), new Date(to), source.alarm.timeZone)
  const starts = events.filter(event => event.type === 'start'), ends = events.filter(event => event.type === 'end')
  const wakes = wakeSpans(source.alarm, from, to, now)
  const ranges = starts.map(start => ({ start,
    end: ends.find(end => end.id === start.id.replace('start:', 'end:') && end.at > start.at) }))
  const days: ({ date: string, window: ExperimentWindow } | SkippedDate)[] = []
  for (let offset = 0; offset < EXPERIMENT_SCHEDULE_DAYS; offset++) {
    const date = new Date(Date.parse(requestedFirstNightDate) + offset * DAY_MS).toISOString().slice(0, 10)
    const candidates = ranges.filter(range => dateInTimeZone(range.start.at, source.alarm.timeZone) === date)
    const skip = (reason: SkippedDate['reason']) => days.push({ date, reason })
    if (!candidates.length) {
      skip('not_scheduled')
      continue
    }
    if (candidates.length !== 1) {
      skip('overlapping_routines')
      continue
    }
    const { start, end } = candidates[0]
    if (start.at <= now) {
      skip('already_started')
      continue
    }
    if (!end || end.at - start.at > 26 * 3_600_000) {
      skip('unbounded_routine')
      continue
    }
    const overlap = ranges.some(range => range.start !== start && range.start.at < end.at
      && (range.end?.at ?? Infinity) > start.at)
    || ends.some(other => other !== end && other.at > start.at && other.at <= end.at)
    if (overlap) {
      skip('overlapping_routines')
      continue
    }
    const applicableWakes = wakes.filter(wake => wake.startsAt < end.at && wake.endsAt > start.at)
    if (applicableWakes.some(wake => !wake.consistent)) {
      skip('conflicting_alarms')
      continue
    }
    if (applicableWakes.some(wake => wake.startsAt <= start.at)) {
      skip('wake_overlap')
      continue
    }
    const wake = applicableWakes[0]?.wake ?? null
    const windowEnd = wake?.startsAt ?? end.at
    if (windowEnd - start.at < EXPERIMENT_MINIMUM_EXPOSURE_MS) {
      skip('too_short')
      continue
    }
    const powerScheduleId = Number(start.id.slice('start:'.length))
    const row = powers.find(power => power.id === powerScheduleId)
    if (!row) throw new ExperimentScheduleError('A scheduled night could not be identified.')
    days.push({ date, window: { date, powerScheduleId, windowStart: start.at, windowEnd,
      routineEnd: end.at, endAction: row.endAction, wake } })
  }

  const windows: ExperimentWindow[] = [], skipped: SkippedDate[] = []
  // A gap between treatment periods is visible. A gap within a settling/scored period is never accepted.
  for (let index = 0; index < days.length && windows.length < EXPERIMENT_NIGHTS; index++) {
    const first = days[index], second = days[index + 1]
    if ('reason' in first) {
      skipped.push(first)
      continue
    }
    if (!second || !('window' in second) || first.window.routineEnd > second.window.windowStart) {
      skipped.push({ date: first.date, reason: 'needs_following_night' })
      continue
    }
    windows.push(first.window, second.window)
    index++
  }
  if (windows.length !== EXPERIMENT_NIGHTS)
    throw new ExperimentScheduleError('A comparison needs eight pairs of consecutive scheduled nights within nine weeks. Review your existing routine; no new nights were added.')
  return experimentScheduleSchema.parse({ requestedFirstNightDate, windows, skipped })
}
