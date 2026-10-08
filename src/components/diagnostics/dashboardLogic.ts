import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import type { SchedJob } from './diagnosticsLogic'

const HOUR = 3_600_000

/** Tonight runs 5 PM → 9 AM; before 9 AM "tonight" is the night that started yesterday. */
export const TONIGHT_START_H = 17
export const TONIGHT_END_H = 33

export interface TonightWindow {
  /** Day the night's curve is saved under. */
  day: DayOfWeek
  /** Local midnight at the start of `day`. */
  midnight: Date
  start: number
  end: number
}

export function tonightWindow(now: Date): TonightWindow {
  const base = now.getHours() < TONIGHT_END_H - 24 ? -1 : 0
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + base)
  const at = (h: number) => new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), h).getTime()
  return { day: DAYS_OF_WEEK[midnight.getDay()], midnight, start: at(TONIGHT_START_H), end: at(TONIGHT_END_H) }
}

/** Scheduler jobs inside the window, oldest first. */
export function jobsInWindow(jobs: SchedJob[] | undefined, w: { start: number, end: number }): SchedJob[] {
  return (jobs ?? [])
    .filter(j => j.nextRun && new Date(j.nextRun).getTime() >= w.start && new Date(j.nextRun).getTime() <= w.end)
    .sort((a, b) => new Date(a.nextRun as string).getTime() - new Date(b.nextRun as string).getTime())
}

const POD_JOB_LABEL: Record<string, string> = {
  prime: 'Prime',
  reboot: 'Reboot',
  calibration: 'Calibrate',
  away_mode: 'Away mode',
  run_once: 'Run once',
  alarm: 'Alarm',
}

/** Jobs drawn on the Pod lane: everything except temperature and power, which the side lanes show. */
export function isPodLaneJob(job: SchedJob): boolean {
  return job.type !== 'temperature' && job.type !== 'power_on' && job.type !== 'power_off'
}

/** Human label for a Pod-lane marker: "LED 2%", "Reboot", "Alarm · Jon". */
export function podJobLabel(job: SchedJob, sideName: (s: 'left' | 'right') => string): string {
  if (job.type === 'led_brightness') return job.brightness != null ? `LED ${job.brightness}%` : 'LED'
  const base = POD_JOB_LABEL[job.type] ?? job.type.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
  if (job.type === 'alarm' && (job.side === 'left' || job.side === 'right')) return `${base} · ${sideName(job.side)}`
  return base
}

/** Next temperature job, for "next: Jon → 80°F at 11:15 PM". */
export function nextTemperatureJob(jobs: SchedJob[] | undefined, now: number): SchedJob | null {
  return (jobs ?? []).find(j => j.type === 'temperature' && j.targetTempF != null && j.nextRun && new Date(j.nextRun).getTime() > now) ?? null
}

export interface AttentionItem {
  id: 'pump-stall' | 'prime' | 'water' | 'occupancy'
  title: string
  detail: string
}

export interface MaintenanceFacts {
  pumpStallProtectionEnabled: boolean
  /** False on pods that never report pump speed (Pod 3/4): the guard can't act there. */
  reportsPumpSpeed?: boolean | null
  primePodDaily: boolean
  lastPrimeAt: number | null
}

const PRIME_STALE_MS = 7 * 24 * HOUR

/**
 * Things on the pod that need someone to act. Empty means the Dashboard hides
 * the card. A daily prime schedule counts as covered; otherwise a missing
 * prime in 7 days (or none recorded yet) is flagged.
 */
export function attentionItems(
  m: MaintenanceFacts | undefined,
  waterLevel: string | undefined,
  now: number,
  suspectSides: ReadonlyArray<string> = [],
): AttentionItem[] {
  const out: AttentionItem[] = []
  if (suspectSides.length > 0) {
    out.push({
      id: 'occupancy',
      title: `${suspectSides.length === 2 ? 'Both sides read' : `The ${suspectSides[0]} side reads`} occupied, but there are no vitals`,
      detail: 'No vitals or movement for over 2 hours. Either nobody is there and the empty-bed reading is off, or vitals are stuck.',
    })
  }
  if (m && !m.pumpStallProtectionEnabled && m.reportsPumpSpeed !== false) {
    out.push({ id: 'pump-stall', title: 'Pump-stall protection is off', detail: 'A stalled pump won\'t power the side down.' })
  }
  if (waterLevel === 'low') {
    out.push({ id: 'water', title: 'Water level is low', detail: 'Top up the tank, then run a prime.' })
  }
  if (m && !m.primePodDaily && (m.lastPrimeAt == null || now - m.lastPrimeAt > PRIME_STALE_MS)) {
    const water = waterLevel === 'ok' ? 'Water level OK.' : waterLevel === 'low' ? 'Water level low.' : ''
    const last = m.lastPrimeAt != null
      ? ` Last primed ${new Date(m.lastPrimeAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}.`
      : ''
    out.push({
      id: 'prime',
      title: m.lastPrimeAt == null ? 'No prime recorded yet' : 'No prime in the last 7 days',
      detail: `${water}${last}`.trim() || 'Daily prime is off.',
    })
  }
  return out
}
