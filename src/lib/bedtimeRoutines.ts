import { z } from 'zod'
import { DAYS_OF_WEEK, hhmmToMinutes, type DayOfWeek } from './scheduleTime'
import { snoozeDurationSchema, snoozeTaperSchema } from '@/src/server/validation-schemas'

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const target = z.number().int().min(55).max(110)
export const routineDaySchema = z.enum(DAYS_OF_WEEK)
export const routineSideSchema = z.enum(['left', 'right'])
export type RoutineSide = z.infer<typeof routineSideSchema>

export const bedtimeDraftSchema = z.object({
  power: z.object({
    onTime: clock, offTime: clock, onTemperature: target,
    enabled: z.boolean(), endAction: z.enum(['turn_off', 'maintain']),
  }).strict(),
  temperatures: z.array(z.object({ time: clock, temperature: target, enabled: z.boolean() }).strict()).max(96),
  alarm: z.object({
    time: clock, vibrationIntensity: z.number().int().min(1).max(100),
    vibrationPattern: z.enum(['rise', 'double']), duration: z.number().int().min(10).max(180),
    alarmTemperature: target, wakeWindow: z.union([z.literal(0), z.literal(10), z.literal(15), z.literal(20), z.literal(30)]), enabled: z.boolean(),
    snoozeDuration: snoozeDurationSchema.optional(), snoozeTaper: snoozeTaperSchema.optional(),
  }).strict().nullable(),
  notes: z.string().max(1000),
}).strict().superRefine((draft, context) => {
  const duration = relativeMinute(draft.power.offTime, draft.power.onTime)
  if (duration === 0 && draft.power.enabled) {
    context.addIssue({ code: 'custom', path: ['power', 'offTime'], message: 'Power-on and end time must differ.' })
  }
  const seen = new Set<string>()
  for (const [index, point] of draft.temperatures.entries()) {
    if (seen.has(point.time)) context.addIssue({ code: 'custom', path: ['temperatures', index, 'time'], message: 'Each temperature phase needs a different time.' })
    seen.add(point.time)
    const offset = relativeMinute(point.time, draft.power.onTime)
    if (point.enabled && (offset === 0 || offset >= duration)) {
      context.addIssue({ code: 'custom', path: ['temperatures', index, 'time'], message: 'Enabled temperature phases must fall between power-on and the end time.' })
    }
  }
})

export type BedtimeDraft = z.infer<typeof bedtimeDraftSchema>
export interface BedtimeRoutine { dayOfWeek: DayOfWeek, draft: BedtimeDraft }
export const routineSnapshotSchema = z.object({
  dayOfWeek: routineDaySchema,
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  draft: bedtimeDraftSchema,
})
export type RoutineSnapshot = z.infer<typeof routineSnapshotSchema>

export const routineChangesSchema = z.object({
  side: routineSideSchema,
  changes: z.array(z.object({
    dayOfWeek: routineDaySchema,
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    replacement: bedtimeDraftSchema.nullable(),
  }).strict()).min(1).max(7),
}).strict().superRefine(({ changes }, context) => {
  if (new Set(changes.map(change => change.dayOfWeek)).size !== changes.length) {
    context.addIssue({ code: 'custom', path: ['changes'], message: 'A day may be changed only once in a save.' })
  }
})

export function relativeMinute(time: string, start: string): number {
  return (hhmmToMinutes(time) - hhmmToMinutes(start) + 1440) % 1440
}

/** A selected weekday is the night the routine starts, including its morning events. */
export function routineEventDay(day: DayOfWeek, time: string, start: string): DayOfWeek {
  return DAYS_OF_WEEK[(DAYS_OF_WEEK.indexOf(day) + Number(time < start)) % 7]
}

export function normalizeBedtimeDraft(input: BedtimeDraft): BedtimeDraft {
  const draft = bedtimeDraftSchema.parse(input)
  return {
    ...draft,
    alarm: draft.alarm ? { ...draft.alarm, snoozeDuration: draft.alarm.snoozeDuration ?? 300, snoozeTaper: draft.alarm.snoozeTaper ?? 0 } : null,
    temperatures: [...draft.temperatures].sort((first, second) => relativeMinute(first.time, draft.power.onTime) - relativeMinute(second.time, draft.power.onTime)),
    notes: draft.notes.trim(),
  }
}

/** Compile a bedtime routine into ordinary scheduler rows without executing controls. */
export function compileBedtimeRoutine(side: RoutineSide, routine: BedtimeRoutine) {
  const draft = normalizeBedtimeDraft(routine.draft)
  const { power } = draft
  const calendar = (time: string) => routineEventDay(routine.dayOfWeek, time, power.onTime)
  return {
    power: [{ side, dayOfWeek: routine.dayOfWeek, ...power, offDayOffset: Number(power.offTime < power.onTime) }],
    temperature: draft.temperatures.map(point => ({ ...point, side, dayOfWeek: calendar(point.time), enabled: power.enabled && point.enabled })),
    alarm: draft.alarm ? [{ ...draft.alarm, side, dayOfWeek: calendar(draft.alarm.time), enabled: power.enabled && draft.alarm.enabled }] : [],
  }
}

/** Reject competing enabled routines across the whole week, including Saturday/Sunday. */
export function validateBedtimeWeek(side: RoutineSide, routines: BedtimeRoutine[]): void {
  const week = 7 * 1440
  const events = new Set<string>()
  const windows: Array<{ start: number, end: number }> = []
  const addEvent = (kind: string, day: DayOfWeek, time: string) => {
    const key = `${kind}:${day}:${time}`
    if (events.has(key)) throw new Error(`Two enabled routines have a ${kind} event on ${day} at ${time}.`)
    events.add(key)
  }
  for (const routine of routines) {
    const rows = compileBedtimeRoutine(side, routine)
    const power = rows.power[0]
    if (power.enabled) {
      const start = DAYS_OF_WEEK.indexOf(power.dayOfWeek) * 1440 + hhmmToMinutes(power.onTime)
      const end = start + relativeMinute(power.offTime, power.onTime)
      for (const window of windows) {
        for (const shift of [-week, 0, week]) {
          if (start < window.end + shift && end > window.start + shift) throw new Error('Enabled bedtime routines overlap. Shorten a routine or choose different nights.')
        }
      }
      windows.push({ start, end })
      addEvent('power', power.dayOfWeek, power.onTime)
      if (power.endAction === 'turn_off') addEvent('power', routineEventDay(power.dayOfWeek, power.offTime, power.onTime), power.offTime)
    }
    for (const point of rows.temperature) if (point.enabled) addEvent('temperature', point.dayOfWeek, point.time)
    for (const alarm of rows.alarm) if (alarm.enabled) addEvent('alarm', alarm.dayOfWeek, alarm.time)
  }
}
