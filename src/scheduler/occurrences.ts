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

function sideOf(md: Record<string, unknown>): 'left' | 'right' | undefined {
  return md.side === 'left' || md.side === 'right' ? md.side : undefined
}

/**
 * Every time each loaded job fires within [from, to), in time order. Recurring
 * jobs are expanded from their cron expression in the scheduler's timezone, so
 * a week view reflects the whole schedule instead of the next few invocations.
 */
export function expandOccurrences(jobs: OccurrenceSource[], from: Date, to: Date, timezone: string): Occurrence[] {
  const out: Occurrence[] = []
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
      if (Number.isFinite(at) && at >= from.getTime() && at < to.getTime()) out.push({ ...base, at })
      continue
    }
    let interval
    try {
      interval = parseExpression(job.schedule, { currentDate: new Date(from.getTime() - 1), endDate: to, tz: timezone })
    }
    catch {
      continue
    }
    for (let i = 0; i < MAX_PER_JOB && interval.hasNext(); i++) {
      const at = interval.next().getTime()
      if (at >= to.getTime()) break
      out.push({ ...base, at })
    }
  }
  return out.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
}
