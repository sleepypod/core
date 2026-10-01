/**
 * View-model for System → Scheduler: plain job labels, the one-line job
 * summary, and bucketing every occurrence into nights for the timeline.
 * Pure so it can be unit-tested without React/tRPC.
 */

import { tempTone, type TempTone } from '@/src/components/Schedule/scheduleFormat'

export type Side = 'left' | 'right'

export interface TimelineOccurrence {
  id: string
  type: string
  side?: Side
  at: number
  targetTempF: number | null
  brightness: number | null
}

export interface TimelineJob {
  id: string
  type: string
  side?: Side
  schedule: string
  oneTime: boolean
  nextRun: number | null
  targetTempF: number | null
  brightness: number | null
}

// ── Labels ───────────────────────────────────────────────────────────────────

export const JOB_TYPE_LABEL: Record<string, string> = {
  temperature: 'Temperature',
  run_once: 'Run once',
  power_on: 'Power on',
  power_off: 'Power off',
  alarm: 'Alarm',
  prime: 'Prime',
  reboot: 'Reboot',
  calibration: 'Calibration',
  led_brightness: 'LED',
  away_mode: 'Away mode',
}

export function jobTypeLabel(type: string): string {
  return JOB_TYPE_LABEL[type] ?? type.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())
}

export type JobGroup = 'temperature' | 'power' | 'alarm' | 'maintenance' | 'other'

const GROUP_OF: Record<string, JobGroup> = {
  temperature: 'temperature',
  run_once: 'temperature',
  power_on: 'power',
  power_off: 'power',
  alarm: 'alarm',
  prime: 'maintenance',
  reboot: 'maintenance',
  calibration: 'maintenance',
}

export const JOB_GROUPS: ReadonlyArray<{ id: JobGroup, label: string }> = [
  { id: 'temperature', label: 'temperature' },
  { id: 'power', label: 'power' },
  { id: 'alarm', label: 'alarm' },
  { id: 'maintenance', label: 'maintenance' },
  { id: 'other', label: 'other' },
]

export function jobGroup(type: string): JobGroup {
  return GROUP_OF[type] ?? 'other'
}

/**
 * Job counts per group, skipping empty groups. Every job lands in exactly one
 * group ('other' catches LED, away mode and anything new), so the parts always
 * add up to the total.
 */
export function groupCounts(jobs: Array<{ type: string }>): Array<{ id: JobGroup, label: string, count: number }> {
  const counts = new Map<JobGroup, number>()
  for (const j of jobs) counts.set(jobGroup(j.type), (counts.get(jobGroup(j.type)) ?? 0) + 1)
  return JOB_GROUPS.map(g => ({ ...g, count: counts.get(g.id) ?? 0 })).filter(g => g.count > 0)
}

export interface JobText {
  /** Who it acts on: the side's name, or 'LED' / 'Reboot' for pod jobs. */
  subject: string
  /** What it sets, or '' when the subject says it all. */
  value: string
  tone: TempTone | 'muted'
}

/** "Left → 80°F", "LED → 2%", "Right → off", "Reboot". */
export function jobText(job: Pick<TimelineOccurrence, 'type' | 'side' | 'targetTempF' | 'brightness'>, sideName: (s: Side) => string): JobText {
  const who = job.side ? sideName(job.side) : 'Pod'
  const temp = job.targetTempF
  switch (job.type) {
    case 'temperature':
    case 'run_once':
      return temp == null ? { subject: who, value: 'end session', tone: 'muted' } : { subject: who, value: `${temp}°F`, tone: tempTone(temp) }
    case 'power_on':
      return { subject: who, value: temp == null ? 'on' : `on · ${temp}°F`, tone: temp == null ? 'muted' : tempTone(temp) }
    case 'power_off':
      return { subject: who, value: 'off', tone: 'muted' }
    case 'alarm':
      return { subject: who, value: 'alarm', tone: 'muted' }
    case 'away_mode':
      return { subject: who, value: 'away mode', tone: 'muted' }
    case 'led_brightness':
      return { subject: 'LED', value: job.brightness == null ? '' : `${job.brightness}%`, tone: 'muted' }
    default:
      return { subject: jobTypeLabel(job.type), value: '', tone: 'muted' }
  }
}

// ── Time ─────────────────────────────────────────────────────────────────────

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a)
  const y = new Date(b)
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
}

/** "11:15 PM" today, "Tue 11:15 PM" on another day. */
export function fmtWhen(ms: number, now: number): string {
  if (sameLocalDay(ms, now)) return fmtTime(ms)
  return `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${fmtTime(ms)}`
}

/** "in 5h 41m", "in 3d 2h", "now". */
export function fmtIn(ms: number, now: number): string {
  const min = Math.floor((ms - now) / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `in ${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `in ${h}h ${min % 60}m`
  return `in ${Math.floor(h / 24)}d ${h % 24}h`
}

const CRON_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * A job's repeat rule in words: "Daily 3:00 AM", "Mon, Wed 11:15 PM", or the
 * date for one-shot jobs. Falls back to the raw expression for anything else.
 */
export function describeSchedule(job: Pick<TimelineJob, 'schedule' | 'oneTime'>): string {
  if (job.oneTime) {
    const at = new Date(job.schedule).getTime()
    return Number.isFinite(at)
      ? `Once · ${new Date(at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(at)}`
      : job.schedule
  }
  const parts = job.schedule.trim().split(/\s+/)
  if (parts.length !== 5 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1]) || parts[2] !== '*' || parts[3] !== '*') return job.schedule
  const d = new Date(2000, 0, 1, Number(parts[1]), Number(parts[0]))
  const time = fmtTime(d.getTime())
  if (parts[4] === '*') return `Daily ${time}`
  const days = parts[4].split(',').map(Number)
  if (days.some(n => !Number.isInteger(n) || n < 0 || n > 7)) return job.schedule
  return `${days.map(n => CRON_DAYS[n % 7]).join(', ')} ${time}`
}

// ── Nights ───────────────────────────────────────────────────────────────────

const HOUR = 3_600_000

export interface Night {
  /** Local noon that starts this night; the night runs to the next noon. */
  start: number
  end: number
  /** "Tonight", then weekday names. */
  label: string
  /** "Mon Sep 28 → Tue Sep 29". */
  dates: string
  occurrences: TimelineOccurrence[]
}

function localNoon(ms: number, addDays = 0): number {
  const d = new Date(ms)
  d.setHours(12, 0, 0, 0)
  d.setDate(d.getDate() + addDays)
  return d.getTime()
}

function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')
}

/**
 * Seven nights starting with the one in progress (before noon, that's the one
 * that began yesterday evening), each holding the occurrences that fall in it.
 */
export function buildNights(occurrences: TimelineOccurrence[], now: number, count = 7): Night[] {
  const first = new Date(now).getHours() < 12 ? localNoon(now, -1) : localNoon(now)
  return Array.from({ length: count }, (_, i) => {
    const start = localNoon(first, i)
    const end = localNoon(first, i + 1)
    return {
      start,
      end,
      label: i === 0 ? 'Tonight' : new Date(start).toLocaleDateString([], { weekday: 'short' }),
      dates: `${shortDate(start)} → ${shortDate(end)}`,
      occurrences: occurrences.filter(o => o.at >= start && o.at < end),
    }
  })
}

/**
 * The hours the timeline shows: 5 PM to 9 AM, widened to whole hours around
 * any side's job outside that span. Pod jobs (a midday prime or reboot) don't
 * widen it, so they can't squash the night; the chart notes them instead.
 */
export function nightAxis(night: Pick<Night, 'start' | 'occurrences'>): { from: number, to: number } {
  let from = night.start + 5 * HOUR
  let to = night.start + 21 * HOUR
  for (const o of night.occurrences) {
    if (!o.side) continue
    if (o.at < from) from = night.start + Math.floor((o.at - night.start) / HOUR) * HOUR
    if (o.at > to) to = night.start + Math.min(24, Math.ceil((o.at - night.start) / HOUR + 0.01)) * HOUR
  }
  return { from, to }
}

export interface SideLane {
  /** Set points in time order (temperature, run-once and power-on targets). */
  points: Array<{ at: number, tempF: number, id: string }>
  on: number[]
  off: number[]
  alarms: number[]
}

export function sideLane(occurrences: TimelineOccurrence[], side: Side): SideLane {
  const lane: SideLane = { points: [], on: [], off: [], alarms: [] }
  for (const o of occurrences) {
    if (o.side !== side) continue
    if (o.type === 'power_on') lane.on.push(o.at)
    if (o.type === 'power_off') lane.off.push(o.at)
    if (o.type === 'alarm') lane.alarms.push(o.at)
    if ((o.type === 'temperature' || o.type === 'run_once' || o.type === 'power_on') && o.targetTempF != null) {
      lane.points.push({ at: o.at, tempF: o.targetTempF, id: o.id })
    }
  }
  return lane
}

/**
 * The target a side's lane holds at `t`: the last set point before it, unless
 * the side powered off in between. Null before the first set point.
 */
export function heldTarget(lane: SideLane, t: number): number | null {
  let held: { at: number, tempF: number } | null = null
  for (const p of lane.points) if (p.at <= t) held = p
  if (!held) return null
  const offAt = held.at
  return lane.off.some(o => o >= offAt && o <= t) ? null : held.tempF
}

/** Jobs that act on the pod rather than a side: LED, reboot, prime, calibration. */
export function podLane(occurrences: TimelineOccurrence[]): TimelineOccurrence[] {
  return occurrences.filter(o => !o.side)
}
