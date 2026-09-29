import { DAYS_OF_WEEK, getCurrentDay, hhmmToMinutes, type DayOfWeek } from '@/src/lib/scheduleTime'
import { sortChronological, type SetPoint } from '@/src/lib/scheduleGrouping'
import { TEMP } from '@/src/lib/tempColors'
import { displayToSetpointF, setpointFToDisplay, type TempUnit } from '@/src/lib/tempUtils'

export interface TempPointRow {
  dayOfWeek: DayOfWeek
  time: string
  temperature: number
  enabled: boolean
}

export interface PowerRow {
  dayOfWeek: DayOfWeek
  onTime: string
  offTime: string
  enabled: boolean
}

export interface AlarmRow {
  id: number
  dayOfWeek: DayOfWeek
  time: string
  duration: number
  enabled: boolean
}

/** ±delta in the user's display unit, converted back to a whole °F set point clamped 55–110. */
export function stepTargetF(currentF: number, delta: number, unit: TempUnit): number {
  const display = setpointFToDisplay(currentF, unit) ?? currentF
  const converted = displayToSetpointF(display + delta, unit) ?? currentF
  return Math.round(Math.max(TEMP.MIN_F, Math.min(TEMP.MAX_F, converted)))
}

/** Offset from the 80°F base in the display unit, with a true minus sign ("−4", "+2", "0"). */
export function offsetLabel(targetF: number, unit: TempUnit): string {
  const t = setpointFToDisplay(targetF, unit) ?? targetF
  const base = setpointFToDisplay(TEMP.BASE_F, unit) ?? TEMP.BASE_F
  const offset = Math.round(t - base)
  if (offset > 0) return `+${offset}`
  if (offset < 0) return `−${Math.abs(offset)}`
  return '0'
}

/** The Date of the next weekly occurrence of `day` at `time` strictly after `now`. */
function nextOccurrence(day: DayOfWeek, time: string, now: Date): Date | null {
  const minutes = hhmmToMinutes(time)
  if (Number.isNaN(minutes)) return null
  const dayIdx = DAYS_OF_WEEK.indexOf(day)
  const at = new Date(now)
  at.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0)
  at.setDate(at.getDate() + ((dayIdx - now.getDay() + 7) % 7))
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 7)
  return at
}

/** Next enabled temperature set point (weekly cron semantics: day + time). */
export function nextSetPoint(points: TempPointRow[], now: Date): { at: Date, time: string, temperature: number } | null {
  let best: { at: Date, time: string, temperature: number } | null = null
  for (const p of points) {
    if (!p.enabled) continue
    const at = nextOccurrence(p.dayOfWeek, p.time, now)
    if (at && (!best || at < best.at)) best = { at, time: p.time, temperature: p.temperature }
  }
  return best
}

export interface TonightPlan {
  /** Night window (power schedule, else first → last set point). */
  window: { start: string, end: string } | null
  /** Tonight's enabled set points in night order. */
  points: SetPoint[]
}

/** Tonight = the schedule day that owns the current night (before 4 AM counts as the previous day). */
export function tonightPlan(temps: TempPointRow[], power: PowerRow[], now: Date): TonightPlan {
  const day = getCurrentDay(now)
  const points = sortChronological(
    temps.filter(t => t.enabled && t.dayOfWeek === day).map(t => ({ time: t.time, temperature: t.temperature })),
  )
  const powerRow = power.find(p => p.enabled && p.dayOfWeek === day)
  const window = powerRow
    ? { start: powerRow.onTime, end: powerRow.offTime }
    : points.length >= 2
      ? { start: points[0].time, end: points[points.length - 1].time }
      : null
  return { window, points }
}

/** "51m", "2h 5m", "<1m". */
export function formatCountdown(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return '<1m'
  const h = Math.floor(totalMinutes / 60)
  const m = totalMinutes % 60
  if (h === 0) return `${m}m`
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/** "7h 9m", "45m". */
export function formatSleepDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (hours === 0) return `${minutes}m`
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
}

const SHORT_DAY: Record<DayOfWeek, string> = {
  sunday: 'Sun', monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu', friday: 'Fri', saturday: 'Sat',
}
const WEEKDAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']
const WEEKEND: DayOfWeek[] = ['saturday', 'sunday']

/**
 * "Daily", "Weekdays", "Weekends", else Mon-first runs: three or more
 * consecutive days collapse to a range ("Mon–Sat", "Sun–Thu"), the rest are
 * listed ("Mon, Wed, Fri"). A range may wrap Sunday → Monday ("Sat–Mon").
 */
export function summarizeDays(days: DayOfWeek[]): string {
  const set = new Set(days)
  if (set.size === 7) return 'Daily'
  if (set.size === 5 && WEEKDAYS.every(d => set.has(d))) return 'Weekdays'
  if (set.size === 2 && WEEKEND.every(d => set.has(d))) return 'Weekends'
  const monFirst: DayOfWeek[] = [...WEEKDAYS, ...WEEKEND]
  let runs: DayOfWeek[][] = []
  monFirst.forEach((d, i) => {
    if (!set.has(d)) return
    if (i > 0 && set.has(monFirst[i - 1])) runs[runs.length - 1].push(d)
    else runs.push([d])
  })
  // A run ending Sunday continues into Monday; join them when that makes a range.
  const first = runs[0]
  const last = runs[runs.length - 1]
  if (runs.length > 1 && first[0] === 'monday' && last[last.length - 1] === 'sunday' && first.length + last.length >= 3) {
    runs = [[...last, ...first], ...runs.slice(1, -1)]
  }
  return runs
    .map(r => (r.length >= 3 ? `${SHORT_DAY[r[0]]}–${SHORT_DAY[r[r.length - 1]]}` : r.map(d => SHORT_DAY[d]).join(', ')))
    .join(', ')
}

export interface AlarmGroup {
  time: string
  rows: AlarmRow[]
  enabled: boolean
  /** Days the group rings on (enabled rows when on, every row when off). */
  days: DayOfWeek[]
  duration: number
}

/**
 * Alarms sharing a time form one group. Shows the group with the next enabled
 * occurrence; with none enabled, the next occurrence of any. `pinnedTime`
 * keeps a group the user just toggled on screen even after it turns off.
 */
export function pickAlarmGroup(alarms: AlarmRow[], now: Date, pinnedTime?: string | null): AlarmGroup | null {
  if (alarms.length === 0) return null
  const soonest = (rows: AlarmRow[]) => {
    let best: { at: Date, time: string } | null = null
    for (const r of rows) {
      const at = nextOccurrence(r.dayOfWeek, r.time, now)
      if (at && (!best || at < best.at)) best = { at, time: r.time }
    }
    return best?.time ?? null
  }
  const pinned = pinnedTime && alarms.some(a => a.time === pinnedTime) ? pinnedTime : null
  const time = pinned ?? soonest(alarms.filter(a => a.enabled)) ?? soonest(alarms)
  if (time == null) return null
  const rows = alarms.filter(a => a.time === time)
  const enabled = rows.some(r => r.enabled)
  const dayRows = enabled ? rows.filter(r => r.enabled) : rows
  return {
    time,
    rows,
    enabled,
    days: dayRows.map(r => r.dayOfWeek),
    duration: dayRows[0]?.duration ?? 0,
  }
}
