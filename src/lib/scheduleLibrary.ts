/**
 * Schedule library rules shared by the server, the Schedule screen and the
 * MCP tools. Every curve is saved; an active curve runs on its days, and two
 * active curves never claim the same side and day. Activating a curve moves
 * any day it shares with another active curve to it; a curve left with no
 * days stops being active.
 */
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'

export type LibrarySide = 'left' | 'right'
export const LIBRARY_SIDES: readonly LibrarySide[] = ['left', 'right']

export interface CurveDays {
  left: DayOfWeek[]
  right: DayOfWeek[]
}

export interface LibraryCurveClaim {
  id: number
  name: string
  days: CurveDays
  active: boolean
}

/** Days one side of another curve gives up. */
export interface DayMove {
  id: number
  name: string
  side: LibrarySide
  days: DayOfWeek[]
  /** True when the curve has no days left and stops being active. */
  deactivated: boolean
}

export interface ClaimPlan {
  /** New days and active flag for every other curve that loses days. */
  updates: Array<{ id: number, days: CurveDays, active: boolean }>
  moves: DayMove[]
}

export const NO_DAYS: CurveDays = { left: [], right: [] }

/** Week order, no duplicates, missing sides empty. */
export function normalizeDays(days: Partial<CurveDays> | undefined): CurveDays {
  const pick = (list: DayOfWeek[] | undefined) => DAYS_OF_WEEK.filter(d => list?.includes(d))
  return { left: pick(days?.left), right: pick(days?.right) }
}

export function hasDays(days: CurveDays): boolean {
  return days.left.length > 0 || days.right.length > 0
}

/** The same days on each of `sides`, none on the others. */
export function daysOnSides(sides: readonly LibrarySide[], days: DayOfWeek[]): CurveDays {
  return normalizeDays({ left: sides.includes('left') ? days : [], right: sides.includes('right') ? days : [] })
}

/** The active curve running `side` on `day`, if any. */
export function activeCurveOn<C extends LibraryCurveClaim>(curves: C[], side: LibrarySide, day: DayOfWeek): C | undefined {
  return curves.find(c => c.active && c.days[side].includes(day))
}

/**
 * What activating curve `targetId` (null for a new curve) on `days` does to
 * the other active curves. Nothing moves when the curve ends up inactive.
 */
export function planClaims(curves: LibraryCurveClaim[], targetId: number | null, days: CurveDays, active: boolean): ClaimPlan {
  const plan: ClaimPlan = { updates: [], moves: [] }
  if (!active) return plan
  for (const other of curves) {
    if (other.id === targetId || !other.active) continue
    const next: CurveDays = { left: [...other.days.left], right: [...other.days.right] }
    const taken: Array<[LibrarySide, DayOfWeek[]]> = []
    for (const side of LIBRARY_SIDES) {
      const overlap = other.days[side].filter(d => days[side].includes(d))
      if (overlap.length === 0) continue
      next[side] = other.days[side].filter(d => !days[side].includes(d))
      taken.push([side, overlap])
    }
    if (taken.length === 0) continue
    const stillActive = hasDays(next)
    plan.updates.push({ id: other.id, days: next, active: stillActive })
    for (const [side, moved] of taken) {
      plan.moves.push({ id: other.id, name: other.name, side, days: moved, deactivated: !stillActive })
    }
  }
  return plan
}

export const CURVE_NAME_MAX = 30

/** `base`, or `base 2`, `base 3`… when taken; trimmed to fit the 30-character name limit with its number. */
export function uniqueCurveName(base: string, taken: ReadonlySet<string>): string {
  let name = base.slice(0, CURVE_NAME_MAX).trim()
  for (let n = 2; taken.has(name); n++) {
    const suffix = ` ${n}`
    name = base.slice(0, CURVE_NAME_MAX - suffix.length).trim() + suffix
  }
  return name
}

/** Moves as the API reports them (curves by name). */
export function movedDays(moves: DayMove[]): Array<Omit<DayMove, 'id'>> {
  return moves.map(({ name, side, days, deactivated }) => ({ name, side, days, deactivated }))
}

/** Set points stored on a curve ({"HH:mm": °F}) as a list. */
export function pointsToSetPoints(points: Record<string, number>): Array<{ time: string, temperature: number }> {
  return Object.entries(points).map(([time, temperature]) => ({ time, temperature }))
}

/** A set point list as a curve stores it. */
export function setPointsToPoints(setPoints: Array<{ time: string, temperature: number }>): Record<string, number> {
  return Object.fromEntries(setPoints.map(p => [p.time, p.temperature]))
}
