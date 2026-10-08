// Tonight on one axis: 6 PM to 9 AM. Pure helpers for the stage's timeline and the
// schedule preview it drives.

import { nightCurve, nextPoint, targetAt, tempRange } from '@/src/components/TempScreen/timelineLogic'
import type { CurvePoint } from '@/src/components/TempScreen/timelineLogic'
import { tonightWindow } from '@/src/components/diagnostics/dashboardLogic'
import type { TempRow } from '@/src/components/Schedule/bothNight'
import type { StageSide } from './stageColors'

export const HOUR = 3_600_000
export const STAGE_NIGHT = { startHour: 18, endHour: 33, tickHours: 3 } as const

export interface StageWindow {
  start: number
  end: number
  midnight: Date
}

/** 6 PM of the day tonight's curve is saved under → 9 AM the next morning. */
export function stageWindow(now: Date): StageWindow {
  const { midnight } = tonightWindow(now)
  const at = (h: number) => new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate(), h).getTime()
  return { start: at(STAGE_NIGHT.startHour), end: at(STAGE_NIGHT.endHour), midnight }
}

/** Hour ticks across the window, every three hours. */
export function stageTicks(win: StageWindow): number[] {
  const ticks: number[] = []
  for (let t = win.start; t <= win.end; t += STAGE_NIGHT.tickHours * HOUR) ticks.push(t)
  return ticks
}

/** 0..1 fraction across the window, clamped. */
export const fractionOf = (win: StageWindow, t: number) => Math.max(0, Math.min(1, (t - win.start) / (win.end - win.start)))
/** Time at a fraction across the window, snapped to whole minutes. */
export const timeAtFraction = (win: StageWindow, fraction: number) => Math.round((win.start + Math.max(0, Math.min(1, fraction)) * (win.end - win.start)) / 60_000) * 60_000

export type StageCurves = Record<StageSide, CurvePoint[]>

export function stageCurves(temps: Record<StageSide, TempRow[] | undefined>, win: StageWindow): StageCurves {
  return {
    left: nightCurve(temps.left, win.midnight),
    right: nightCurve(temps.right, win.midnight),
  }
}

/** One temperature range shared by both curves so they read against each other. */
export const stageRange = (curves: StageCurves) => tempRange([curves.left, curves.right])

/** What the schedule holds for a side at `t`; null when the side is off then. */
export const scheduledAt = (curves: StageCurves, side: StageSide, t: number) => targetAt([curves[side]], t)

export interface NextChange {
  side: StageSide
  at: number
  temperatureF: number
}

/** The soonest set point after `now` on either side. */
export function nextChange(curves: StageCurves, now: number): NextChange | null {
  let best: NextChange | null = null
  for (const side of ['left', 'right'] as StageSide[]) {
    const point = nextPoint([curves[side]], now)
    if (point && (!best || point.at < best.at)) best = { side, at: point.at, temperatureF: point.temperature }
  }
  return best
}

/** "2h 08m" / "45m", minutes zero-padded under an hour count. */
export function formatUntil(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60_000))
  const h = Math.floor(total / 60)
  const m = total % 60
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const hourLabel = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric' })
