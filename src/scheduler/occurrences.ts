import { parseExpression } from 'cron-parser'

export interface OccurrenceSource {
  id: string
  type: string
  schedule: string
  oneTime?: boolean
  metadata?: Record<string, unknown>
}

export interface Occurrence {
  id: string
  type: string
  side?: 'left' | 'right'
  at: number
  targetTempF: number | null
  brightness: number | null
}

/** Safety cap per job; a weekly cron fires at most ~10 times in the widest window we ask for. */
const MAX_PER_JOB = 64
const DAY = 86_400_000

/** "m h * * *" or "m h * * 1,3,5" — what JobManager builds for every recurring job. */
const SIMPLE_CRON = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-7](?:,[0-7])*)$/

function sideOf(md: Record<string, unknown>): 'left' | 'right' | undefined {
  return md.side === 'left' || md.side === 'right' ? md.side : undefined
}

interface LocalDay {
  y: number
  m: number
  d: number
  /** 0 = Sunday, like cron. */
  weekday: number
  /** Zone offset at the day's start and end; they differ only on DST days. */
  offStart: number
  offEnd: number
}

/**
 * The zone's calendar days overlapping [from, to), with their UTC offsets.
 * One Intl formatter serves the whole call: cron-parser's per-step timezone
 * math took ~10 s for a day of 329 jobs on the pod's CPU and blocked the
 * event loop, so simple crons are expanded here instead.
 */
function localDays(from: number, to: number, timezone: string): { days: LocalDay[], offsetAt: (utcMs: number) => number } {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const wall = (utcMs: number) => {
    const p = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(x => [x.type, Number(x.value)]))
    return { y: p.year, m: p.month, d: p.day, ms: Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) }
  }
  const offsetAt = (utcMs: number) => wall(utcMs).ms - Math.floor(utcMs / 1000) * 1000
  const first = wall(from)
  const days: LocalDay[] = []
  for (let i = -1; i <= Math.ceil((to - from) / DAY) + 1; i++) {
    const date = new Date(Date.UTC(first.y, first.m - 1, first.d + i))
    const y = date.getUTCFullYear()
    const m = date.getUTCMonth() + 1
    const d = date.getUTCDate()
    const midnight = Date.UTC(y, m - 1, d)
    // Sample the "start" offset three hours before the day begins: zones such
    // as America/Havana spring forward at midnight, so the offset at the day's
    // first instant is already the post-transition one and a 00:30 row would
    // otherwise resolve to the previous evening.
    const dayStart = midnight - offsetAt(midnight)
    days.push({ y, m, d, weekday: date.getUTCDay(), offStart: offsetAt(dayStart - 3 * 3_600_000), offEnd: offsetAt(midnight + DAY - 1 - offsetAt(midnight + DAY - 1)) })
  }
  return { days, offsetAt }
}

/**
 * A wall time on a DST day: an ambiguous time (fall back) takes its first
 * occurrence and a skipped one (spring forward) lands just past the gap,
 * matching cron-parser. Midnight gaps are skipped entirely.
 */
function resolveDstWallTime(guess: number, day: LocalDay, offsetAt: (utcMs: number) => number): number | null {
  const candidates = [guess - day.offStart, guess - day.offEnd].filter(c => c + offsetAt(c) === guess)
  if (candidates.length) return Math.min(...candidates)
  // cron-parser skips nonexistent midnight occurrences rather than shifting
  // them into the next hour. Ordinary spring gaps still shift forward.
  return new Date(guess).getUTCHours() === 0 ? null : guess - day.offStart
}

export type WeeklyZone = ReturnType<typeof localDays>

/**
 * The zone's days around `now`, wide enough that every weekday has one
 * occurrence on each side of `now`, even when a DST gap skips a week.
 * Build once per pass and share it across
 * rows: the Intl formatter is the expensive part.
 */
export function weeklyZone(now: number, timezone: string): WeeklyZone {
  return localDays(now - 15 * DAY, now + 15 * DAY, timezone)
}

/**
 * For a weekly `minute hour * * weekday` schedule: the latest firing at or
 * before `now` and the next one after it, with cron-parser's DST semantics
 * (midnight gaps are skipped, other spring gaps shift forward, fall times fire
 * once). Replaces `parseExpression(...).next()` for the temperature baseline,
 * where one cron-parser row cost ~0.5 s on the pod's CPU.
 */
export function weeklyWindow(zone: WeeklyZone, weekday: number, hour: number, minute: number, now: number): { startsAt: number, expiresAt: number } {
  let startsAt = -Infinity
  let expiresAt = Infinity
  for (const day of zone.days) {
    if (day.weekday !== weekday % 7) continue
    const guess = Date.UTC(day.y, day.m - 1, day.d, hour, minute)
    const at = day.offStart === day.offEnd ? guess - day.offStart : resolveDstWallTime(guess, day, zone.offsetAt)
    if (at === null) continue
    if (at <= now) {
      if (at > startsAt) startsAt = at
    }
    else if (at < expiresAt) {
      expiresAt = at
    }
  }
  return { startsAt, expiresAt }
}

/**
 * Every time each loaded job fires within [from, to), in time order. Recurring
 * jobs are expanded from their cron expression in the scheduler's timezone, so
 * a week view reflects the whole schedule instead of the next few invocations.
 */
export function expandOccurrences(jobs: OccurrenceSource[], from: Date, to: Date, timezone: string): Occurrence[] {
  const out: Occurrence[] = []
  const fromMs = from.getTime()
  const toMs = to.getTime()
  let zone: ReturnType<typeof localDays> | null = null

  for (const job of jobs) {
    const md = job.metadata ?? {}
    const base = {
      id: job.id,
      type: job.type,
      side: sideOf(md),
      targetTempF: typeof md.targetTemperature === 'number' ? md.targetTemperature : null,
      brightness: typeof md.brightness === 'number' ? md.brightness : null,
    }
    if (job.oneTime) {
      const at = new Date(job.schedule).getTime()
      if (Number.isFinite(at) && at >= fromMs && at < toMs) out.push({ ...base, at })
      continue
    }

    const simple = SIMPLE_CRON.exec(job.schedule.trim())
    if (simple) {
      const minute = Number(simple[1])
      const hour = Number(simple[2])
      const dows = simple[3] === '*' ? null : new Set(simple[3].split(',').map(n => Number(n) % 7))
      if (minute > 59 || hour > 23) continue
      zone ??= localDays(fromMs, toMs, timezone)
      for (const day of zone.days) {
        if (dows && !dows.has(day.weekday)) continue
        const guess = Date.UTC(day.y, day.m - 1, day.d, hour, minute)
        const at = day.offStart === day.offEnd ? guess - day.offStart : resolveDstWallTime(guess, day, zone.offsetAt)
        if (at !== null && at >= fromMs && at < toMs) out.push({ ...base, at })
      }
      continue
    }

    let interval
    try {
      interval = parseExpression(job.schedule, { currentDate: new Date(fromMs - 1), endDate: to, tz: timezone })
    }
    catch {
      continue
    }
    for (let i = 0; i < MAX_PER_JOB && interval.hasNext(); i++) {
      const at = interval.next().getTime()
      if (at >= toMs) break
      out.push({ ...base, at })
    }
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
