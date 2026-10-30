import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Side } from '@/src/hardware/types'
import { DAYS_OF_WEEK } from '@/src/lib/scheduleTime'
import { weeklyWindow, weeklyZone, type WeeklyZone } from '@/src/scheduler/occurrences'
import { alarmTemperatureTargets, alarmWarmupMinutes, ALARM_HOLD_AFTER_MIN, type AlarmOccurrenceCache } from '@/src/temperature/baseline'
import { NextAlarmError, type NextAlarm } from './contract'

export const alarmRowSchema = z.object({
  id: z.number().int().positive(), side: z.enum(['left', 'right']), dayOfWeek: z.enum(DAYS_OF_WEEK),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  vibrationIntensity: z.number().int().min(1).max(100), vibrationPattern: z.enum(['rise', 'double']),
  duration: z.number().int().min(0).max(180), alarmTemperature: z.number().min(55).max(110),
  wakeWindow: z.number().int().min(0).max(120), snoozeDuration: z.number().int().nonnegative(), snoozeTaper: z.number().int().min(0).max(100),
})
export type AlarmRow = z.infer<typeof alarmRowSchema>
export const overrideSchema = z.object({
  plan: z.string().regex(/^[a-f0-9]{64}$/), ids: z.array(z.number().int().positive()).min(1),
  originalAt: z.number().int().positive(), at: z.number().int().positive().nullable(), expiresAt: z.number().int().positive(),
}).strict()
export type AlarmOverride = z.infer<typeof overrideSchema>
export interface AlarmContext {
  side: Side
  timeZone: string
  available: boolean
  configured: boolean
  rows: AlarmRow[]
  revision: string | null
  override: AlarmOverride | null
}
export interface AlarmOccurrence {
  rows: AlarmRow[]
  originalAt: number
  at: number
  skipped: boolean
  token: string
  source: 'routine' | 'override'
}
export type AlarmExecution = NextAlarm['execution']
export function alarmDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
export function alarmPlan(context: AlarmContext): string {
  return alarmDigest([context.timeZone, context.rows])
}
export function validAlarmOverride(context: AlarmContext, now: number): AlarmOverride | null {
  const record = context.override
  return record && record.plan === alarmPlan(context) && record.expiresAt > now ? record : null
}
function weeklyAt(row: AlarmRow, zone: WeeklyZone, after: number): number {
  const [hour, minute] = row.time.split(':').map(Number)
  return weeklyWindow(zone, DAYS_OF_WEEK.indexOf(row.dayOfWeek), hour, minute, after).expiresAt
}
export function nextRoutineAlarm(context: AlarmContext, after: number): { at: number, rows: AlarmRow[] } | null {
  if (!context.rows.length) return null
  const zone = weeklyZone(after, context.timeZone)
  const candidates = context.rows.map(row => ({ row, at: weeklyAt(row, zone, after) }))
  const at = Math.min(...candidates.map(candidate => candidate.at))
  return { at, rows: candidates.filter(candidate => candidate.at === at).map(candidate => candidate.row) }
}
export function occurrenceAt(context: AlarmContext, originalAt: number, now: number): AlarmOccurrence | null {
  const routine = nextRoutineAlarm(context, originalAt - 1)
  if (!routine || routine.at !== originalAt) return null
  const record = validAlarmOverride(context, now)
  const changed = record?.originalAt === originalAt && alarmDigest(record.ids) === alarmDigest(routine.rows.map(row => row.id)) ? record : null
  return { rows: routine.rows, originalAt, at: changed?.at ?? originalAt, skipped: changed?.at === null,
    source: changed ? 'override' : 'routine', token: alarmDigest([context.timeZone, routine.rows, context.revision, originalAt, changed]) }
}
export function selectedAlarm(context: AlarmContext, now: number): AlarmOccurrence | null {
  const changed = validAlarmOverride(context, now)
  const originalAt = changed?.originalAt ?? nextRoutineAlarm(context, now - 1)?.at
  return originalAt === undefined ? null : occurrenceAt(context, originalAt, now)
}
function profile(row: AlarmRow) {
  return { vibrationIntensity: row.vibrationIntensity, vibrationPattern: row.vibrationPattern, duration: row.duration,
    alarmTemperature: row.alarmTemperature, wakeWindow: row.wakeWindow, snoozeDuration: row.snoozeDuration, snoozeTaper: row.snoozeTaper }
}
export function consistentAlarm(occurrence: AlarmOccurrence): boolean {
  return occurrence.rows.every(row => alarmDigest(profile(row)) === alarmDigest(profile(occurrence.rows[0])))
}
export function alarmHoldEnd(at: number, rows: AlarmRow[]): number {
  return at + Math.max(...rows.map(row => row.duration)) * 1000 + ALARM_HOLD_AFTER_MIN * 60_000
}
export function alarmClock(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
}

/** A user-selected clock time must occur exactly once on the displayed wake date. */
export function resolveAlarmClock(originalAt: number, time: string, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const wall = (at: number) => Object.fromEntries(formatter.formatToParts(at).map(part => [part.type, part.value]))
  const date = wall(originalAt)
  const [hour, minute] = time.split(':').map(Number)
  const desired = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day), hour, minute)
  const offsets = new Set<number>()
  for (const hours of [-48, -24, 0, 24, 48]) {
    const sample = desired + hours * 3_600_000
    const parts = wall(sample)
    offsets.add(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - sample)
  }
  const candidates = [...offsets].map(offset => desired - offset).filter((at) => {
    const parts = wall(at)
    return parts.year === date.year && parts.month === date.month && parts.day === date.day && `${parts.hour}:${parts.minute}` === time
  })
  if (candidates.length !== 1) throw new NextAlarmError('That time is skipped or occurs twice when the clock changes. Choose an unambiguous time on the same wake date.', 'BAD_REQUEST')
  return candidates[0]
}

/** The same effective spans feed arbitration, comfort guards, and delayed shutdown. */
export function effectiveAlarmTargets(context: AlarmContext, now: number, cache?: AlarmOccurrenceCache) {
  if (!context.available) return []
  const changed = validAlarmOverride(context, now)
  const targets = alarmTemperatureTargets(context.rows.map(row => ({ id: `alarm:${row.id}`, dayOfWeek: row.dayOfWeek,
    time: row.time, temperature: row.alarmTemperature, wakeWindow: row.wakeWindow, duration: row.duration })), context.timeZone, now, cache)
    .filter(target => !changed || !context.rows.some(row => changed.ids.includes(row.id) && target.id === `alarm:${row.id}`
      && target.startsAt === changed.originalAt - alarmWarmupMinutes(row.wakeWindow) * 60_000))
  if (changed?.at !== null && changed?.at !== undefined) {
    for (const row of context.rows.filter(row => changed.ids.includes(row.id))) {
      const startsAt = changed.at - alarmWarmupMinutes(row.wakeWindow) * 60_000
      const expiresAt = alarmHoldEnd(changed.at, [row])
      if (now >= startsAt && now < expiresAt) targets.push({ id: `alarm-override:${row.id}`, source: 'schedule', temperature: row.alarmTemperature,
        startsAt, expiresAt, createdAt: startsAt, priority: 1 })
    }
  }
  return targets
}
