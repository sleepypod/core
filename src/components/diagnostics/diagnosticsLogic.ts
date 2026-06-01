/**
 * Pure view-model logic for the diagnostics console — formatting, scheduler
 * lane bucketing, and the biometrics/thermal derivations. Kept free of React
 * and tRPC so it can be unit-tested directly; the console is a thin view over
 * these functions.
 */

// ── Formatting ───────────────────────────────────────────────────────────────

export function fmtF(v: number | null | undefined): string {
  return v == null ? '—' : `${v.toFixed(1)}°F`
}

export function fmtAge(sec: number | null | undefined): string {
  if (sec == null) return 'no reading'
  if (sec < 90) return `${sec}s`
  return `${Math.round(sec / 60)}m`
}

export function fmtMs(ms: number | undefined): string {
  if (ms == null) return '—'
  if (ms < 1) return '<1ms'
  return `${Math.round(ms)}ms`
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  return v == null ? '—' : v.toFixed(digits)
}

export function minutesSince(ms: number): number {
  return Math.max(0, Math.floor((Date.now() - ms) / 60000))
}

export function fmtRel(iso: string | null): string {
  if (!iso) return '—'
  const diffMs = new Date(iso).getTime() - Date.now()
  if (diffMs < 0) return 'past'
  const min = Math.floor(diffMs / 60_000)
  if (min < 1) return '<1m'
  if (min < 60) return `${min}m`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ${min % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function fmtClock(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'
}

export function fmtDayLabel(ms: number): { weekday: string, day: string } {
  const d = new Date(ms)
  return {
    weekday: d.toLocaleDateString([], { weekday: 'short' }),
    day: d.toLocaleDateString([], { day: 'numeric', month: 'short' }),
  }
}

export const VERDICT_STYLES: Record<string, { label: string, className: string }> = {
  delivering: { label: 'DELIVERING', className: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' },
  idle: { label: 'IDLE', className: 'bg-sky-500/15 text-sky-300 ring-sky-500/30' },
  off: { label: 'OFF', className: 'bg-zinc-600/20 text-zinc-400 ring-zinc-600/30' },
  stalled: { label: 'STALLED', className: 'bg-red-500/20 text-red-300 ring-red-500/40' },
}

// ── Scheduler lanes ────────────────────────────────────────────────────────────

export interface SchedJob { id: string, type: string, side?: string, nextRun: string | null }

export interface DayLane { date: number, isToday: boolean, jobs: SchedJob[] }

const DAY_MS = 86_400_000

/** Bucket upcoming jobs into the next 7 day-lanes, starting at local midnight today. */
export function buildWeekLanes(jobs: SchedJob[]): DayLane[] {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const startMs = start.getTime()
  const lanes: DayLane[] = Array.from({ length: 7 }, (_, i) => ({ date: startMs + i * DAY_MS, isToday: i === 0, jobs: [] }))
  for (const j of jobs) {
    if (!j.nextRun) continue
    const idx = Math.floor((new Date(j.nextRun).getTime() - startMs) / DAY_MS)
    if (idx >= 0 && idx < 7) lanes[idx].jobs.push(j)
  }
  for (const lane of lanes) lane.jobs.sort((a, b) => new Date(a.nextRun ?? 0).getTime() - new Date(b.nextRun ?? 0).getTime())
  return lanes
}

export function jobTone(type: string): string {
  const t = type.toLowerCase()
  if (t.includes('temp')) return 'bg-orange-500/15 text-orange-300'
  if (t.includes('off')) return 'bg-zinc-600/30 text-zinc-300'
  if (t.includes('on')) return 'bg-emerald-500/15 text-emerald-300'
  if (t.includes('alarm')) return 'bg-amber-500/15 text-amber-300'
  if (t.includes('prime')) return 'bg-sky-500/15 text-sky-300'
  if (t.includes('reboot')) return 'bg-purple-500/15 text-purple-300'
  return 'bg-zinc-700/40 text-zinc-300'
}

// ── Biometrics data-flow check ──────────────────────────────────────────────────

export type FlowTone = 'ok' | 'warn' | 'error' | 'idle'

interface VitalLike { timestamp: Date | string }
interface OccupancyLike { left: { occupied: boolean }, right: { occupied: boolean } }
interface FileCountLike { rawFiles: { left: number, right: number } }

/**
 * Synthesize a live "is biometric data being written" verdict. The failure we
 * care about: an occupied bed while the ingest pipeline has quietly stalled, so
 * vitals stop arriving even though everything reports healthy.
 */
export function biometricsFlowStatus(
  rows: VitalLike[],
  occupancy: OccupancyLike | undefined,
  fileCount: FileCountLike | undefined,
): { tone: FlowTone, label: string } {
  const lastMs = rows.length ? Math.max(...rows.map(r => new Date(r.timestamp).getTime())) : null
  const ageMin = lastMs != null ? minutesSince(lastMs) : null
  const rawTotal = fileCount ? fileCount.rawFiles.left + fileCount.rawFiles.right : null
  const occupied = occupancy ? occupancy.left.occupied || occupancy.right.occupied : false
  const fresh = ageMin != null && ageMin <= 10

  if (lastMs == null && !rawTotal) {
    return { tone: 'error', label: 'No biometric data — nothing is being written' }
  }
  if (occupied && !fresh) {
    return {
      tone: 'warn',
      label: ageMin == null
        ? 'Bed occupied but no vitals recorded — pipeline may be stalled'
        : `Bed occupied but last vital was ${ageMin}m ago — pipeline may be stalled`,
    }
  }
  if (fresh) {
    return { tone: 'ok', label: `Data flowing · last record ${ageMin}m ago${rawTotal != null ? ` · ${rawTotal} RAW files` : ''}` }
  }
  return {
    tone: 'idle',
    label: ageMin == null ? 'No recent vitals (bed empty)' : `No recent vitals · last ${ageMin}m ago (bed empty)`,
  }
}

// ── Thermal trend ───────────────────────────────────────────────────────────────

export interface ThermalSideSnapshot {
  side: string
  isPowered: boolean
  targetTempF: number | null
  currentTempF: number | null
  waterTempF: number | null
}

export interface ThermalTrendPoint {
  t: number
  target: number | null
  bed: number | null
  water: number | null
}

/** Project the buffered thermal history into a per-side trend series. */
export function thermalTrendPoints(
  history: Array<{ t: number, sides: ThermalSideSnapshot[] }>,
  side: string,
): ThermalTrendPoint[] {
  return history.map((h) => {
    const hs = h.sides.find(x => x.side === side)
    return {
      t: h.t,
      target: hs?.isPowered ? hs.targetTempF ?? null : null,
      bed: hs?.currentTempF ?? null,
      water: hs?.waterTempF ?? null,
    }
  })
}
