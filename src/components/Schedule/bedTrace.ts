import type { ThermalHistoryPoint } from '@/src/lib/thermalHistory'
import type { BedSample } from './CurveChart'

type Side = 'left' | 'right'
const MINUTE = 60_000

/**
 * Measured bed temperature from thermal history on a curve chart's minute
 * axis: minutes after `midnight` (the night-start day's local midnight, so
 * 2 AM the next morning is minute 1560) plus `offset`, which the Tonight
 * lanes use when a curve saved entirely after midnight sits a day earlier.
 * Prefers the regulated bed reading; before thermal_state has history it
 * falls back to the surface sensor.
 */
export function bedTrace(points: ThermalHistoryPoint[] | undefined, side: Side, midnight: Date, offset = 0): BedSample[] {
  if (!points || points.length === 0) return []
  const bedKey = side === 'left' ? 'leftBed' : 'rightBed'
  const surfaceKey = side === 'left' ? 'leftSurface' : 'rightSurface'
  const key = points.some(p => p[bedKey] != null) ? bedKey : surfaceKey
  const base = midnight.getTime()
  const out: BedSample[] = []
  for (const p of points) {
    const v = p[key]
    if (v == null) continue
    out.push({ minutes: (p.t - base) / MINUTE + offset, temperature: v })
  }
  return out
}

/**
 * Local midnight of the day the most recent night started: yesterday, so a
 * 10 PM → 7 AM curve maps to minutes 1320 → 1860 whether it is still running
 * (early morning) or finished hours ago.
 */
export function lastNightMidnight(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
}

/** "tonight" while the night is still going (before 9 AM), "last night" after. */
export function lastNightLabel(now: Date): string {
  return now.getHours() < 9 ? 'tonight' : 'last night'
}

/**
 * History range that reaches back to last night's start: 24 h covers it
 * until the evening, after which a 10 PM start is more than a day ago.
 */
export function lastNightRange(now: Date): '24h' | '48h' {
  return now.getHours() >= 18 ? '48h' : '24h'
}
