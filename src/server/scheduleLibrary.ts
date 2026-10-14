/**
 * Keeps the temperature and power schedule rows in step with the schedule
 * library (curve_templates). The scheduler only ever reads the rows; an
 * active curve's set points are written to every side and day it claims,
 * and taking a day away from a curve clears or replaces that day's rows.
 */
import { and, eq, inArray } from 'drizzle-orm'
import type { db } from '@/src/db'
import { curveTemplates, powerSchedules, scheduleNotes, sideSettings, temperatureSchedules } from '@/src/db/schema'
import type { getJobManager } from '@/src/scheduler'
import { endActionForDay, sortChronological } from '@/src/lib/scheduleGrouping'
import { planCurveSave } from '@/src/lib/sleepCurve/savePlan'
import { DAYS_OF_WEEK, type DayOfWeek } from '@/src/lib/scheduleTime'
import {
  activeCurveOn,
  type CurveDays,
  hasDays,
  LIBRARY_SIDES,
  type LibraryCurveClaim,
  type LibrarySide,
  normalizeDays,
  pointsToSetPoints,
  setPointsToPoints,
  uniqueCurveName,
} from '@/src/lib/scheduleLibrary'
import { formatDayRange } from '@/src/components/Schedule/scheduleFormat'

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type CurveRow = typeof curveTemplates.$inferSelect
type TemperatureRow = typeof temperatureSchedules.$inferSelect
type PowerRow = typeof powerSchedules.$inferSelect

/** Job changes to hand the scheduler once the transaction commits. */
export interface SchedulerOps {
  cancelTemperature: number[]
  cancelPower: number[]
  upsertTemperature: TemperatureRow[]
  upsertPower: PowerRow[]
}

export function emptySchedulerOps(): SchedulerOps {
  return { cancelTemperature: [], cancelPower: [], upsertTemperature: [], upsertPower: [] }
}

/**
 * Apply an incremental scheduler mutation. The helper resolves the job
 * manager and invokes `fn`; failures are logged but never thrown out of the
 * route handler — schedule writes already committed, and the heartbeat
 * liveness loop will recover any drift.
 */
export async function applyScheduler(fn: (jm: Awaited<ReturnType<typeof getJobManager>>) => void | Promise<void>): Promise<void> {
  try {
    // Loaded on use: adopting schedules during migrations must not start the scheduler's module graph.
    const { getJobManager } = await import('@/src/scheduler')
    const jobManager = await getJobManager()
    await fn(jobManager)
  }
  catch (e) {
    console.error('Scheduler update failed:', e)
  }
}

export async function applySchedulerOps(ops: SchedulerOps): Promise<void> {
  if (ops.cancelTemperature.length + ops.cancelPower.length + ops.upsertTemperature.length + ops.upsertPower.length === 0) return
  await applyScheduler((jm) => {
    for (const id of ops.cancelTemperature) jm.cancelTemperatureJob(id)
    for (const id of ops.cancelPower) jm.cancelPowerJob(id)
    for (const row of ops.upsertTemperature) jm.upsertTemperatureJob(row)
    for (const row of ops.upsertPower) jm.upsertPowerJob(row)
  })
}

export function curveDays(row: Pick<CurveRow, 'leftDays' | 'rightDays'>): CurveDays {
  return normalizeDays({ left: row.leftDays, right: row.rightDays })
}

export function toClaim(row: CurveRow): LibraryCurveClaim {
  return { id: row.id, name: row.name, days: curveDays(row), active: row.active }
}

/** Write `curve` on `side` for `targetDays` and clear `clearDays`; other days and alarms are untouched. */
function writeSide(tx: Tx, curve: Pick<CurveRow, 'points' | 'endAction' | 'notes'>, side: LibrarySide, targetDays: DayOfWeek[], clearDays: DayOfWeek[], ops: SchedulerOps) {
  const existing = {
    temperature: tx.select({ id: temperatureSchedules.id, dayOfWeek: temperatureSchedules.dayOfWeek })
      .from(temperatureSchedules).where(eq(temperatureSchedules.side, side)).all(),
    power: tx.select({ id: powerSchedules.id, dayOfWeek: powerSchedules.dayOfWeek })
      .from(powerSchedules).where(eq(powerSchedules.side, side)).all(),
  }
  const plan = planCurveSave({
    sides: [side],
    targetDays,
    clearDays,
    setPoints: pointsToSetPoints(curve.points),
    endAction: curve.endAction,
    notes: curve.notes,
    existing,
  })

  if (plan.deletes.temperature.length > 0) {
    tx.delete(temperatureSchedules).where(inArray(temperatureSchedules.id, plan.deletes.temperature)).run()
    ops.cancelTemperature.push(...plan.deletes.temperature)
  }
  if (plan.deletes.power.length > 0) {
    tx.delete(powerSchedules).where(inArray(powerSchedules.id, plan.deletes.power)).run()
    ops.cancelPower.push(...plan.deletes.power)
  }
  for (const entry of plan.creates.temperature) {
    ops.upsertTemperature.push(tx.insert(temperatureSchedules).values(entry).returning().get())
  }
  for (const entry of plan.creates.power) {
    ops.upsertPower.push(tx.insert(powerSchedules).values(entry).returning().get())
  }
  for (const { dayOfWeek, notes } of plan.notes) {
    if (notes) {
      tx.insert(scheduleNotes).values({ side, dayOfWeek, notes, updatedAt: new Date() })
        .onConflictDoUpdate({ target: [scheduleNotes.side, scheduleNotes.dayOfWeek], set: { notes, updatedAt: new Date() } })
        .run()
    }
    else {
      tx.delete(scheduleNotes).where(and(eq(scheduleNotes.side, side), eq(scheduleNotes.dayOfWeek, dayOfWeek))).run()
    }
  }
}

/**
 * Bring the rows in line with `curve` after it changed: an active curve is
 * written to its days, and days it held before (`before`, null for a new
 * curve) but no longer runs on are cleared. Days another curve just gave up
 * are among the ones written, so their old rows are replaced here too.
 */
export function syncCurveRows(tx: Tx, curve: CurveRow, before: { days: CurveDays, active: boolean } | null, ops: SchedulerOps) {
  const now = curveDays(curve)
  for (const side of LIBRARY_SIDES) {
    const target = curve.active ? now[side] : []
    const clear = before?.active ? before.days[side] : []
    if (target.length === 0 && clear.length === 0) continue
    writeSide(tx, curve, side, target, clear, ops)
  }
}

/** Store new days and active flags on other curves (moving days does not reorder the library). */
export function applyClaimUpdates(tx: Tx, updates: Array<{ id: number, days: CurveDays, active: boolean }>) {
  for (const u of updates) {
    tx.update(curveTemplates)
      .set({ leftDays: u.days.left, rightDays: u.days.right, active: u.active })
      .where(eq(curveTemplates.id, u.id))
      .run()
  }
}

/**
 * Rows on these sides and days were edited one by one (not through the
 * library), so they no longer match the curve that claimed them: the curve
 * gives those days up, and stops being active if it has none left.
 */
export function releaseDays(tx: Tx, pairs: Array<{ side: LibrarySide, dayOfWeek: DayOfWeek }>) {
  if (pairs.length === 0) return
  const active = tx.select().from(curveTemplates).where(eq(curveTemplates.active, true)).all()
  for (const curve of active) {
    const days = curveDays(curve)
    let changed = false
    for (const { side, dayOfWeek } of pairs) {
      if (!days[side].includes(dayOfWeek)) continue
      days[side] = days[side].filter(d => d !== dayOfWeek)
      changed = true
    }
    if (changed) applyClaimUpdates(tx, [{ id: curve.id, days, active: hasDays(days) }])
  }
}

function uniqueName(base: string, taken: Set<string>): string {
  const name = uniqueCurveName(base, taken)
  taken.add(name)
  return name
}

/**
 * Put every schedule that is not in the library yet into it: days on a side
 * with the same set points and end action become one curve (one curve for
 * both sides when they match), active on those days. Rows are not
 * rewritten, so what the Pod does is unchanged. A saved curve with no days
 * and the same set points is used instead of a new one. Returns the number
 * of curves that now run schedules they did not before.
 */
export function adoptUnmanagedSchedules(tx: Tx): number {
  const curves = tx.select().from(curveTemplates).all()
  const claims = curves.map(toClaim)
  const temps = tx.select().from(temperatureSchedules).all()
  const power = tx.select().from(powerSchedules).all()
  const notes = tx.select().from(scheduleNotes).all()
  const sideNames = new Map(tx.select().from(sideSettings).all().map(s => [s.side, s.name] as const))

  const groups = new Map<string, { points: Record<string, number>, endAction: 'turn_off' | 'maintain', days: CurveDays, notes: string }>()
  for (const side of LIBRARY_SIDES) {
    const sidePower = power.filter(p => p.side === side)
    for (const day of DAYS_OF_WEEK) {
      if (activeCurveOn(claims, side, day)) continue
      const rows = temps.filter(t => t.side === side && t.dayOfWeek === day)
      if (rows.length === 0) continue
      const points = setPointsToPoints(sortChronological(rows))
      const endAction = endActionForDay(sidePower, day)
      const key = `${endAction}|${Object.entries(points).sort(([a], [b]) => a.localeCompare(b)).map(([t, v]) => `${t}@${v}`).join(',')}`
      const group = groups.get(key) ?? { points, endAction, days: { left: [], right: [] }, notes: '' }
      group.days[side].push(day)
      group.notes ||= notes.find(n => n.side === side && n.dayOfWeek === day)?.notes ?? ''
      groups.set(key, group)
    }
  }
  if (groups.size === 0) return 0

  const sameCurve = (a: Record<string, number>, b: Record<string, number>) =>
    Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([t, v]) => b[t] === v)
  const taken = new Set(curves.map(c => c.name))
  const label = (days: CurveDays) => days.left.length > 0 && days.right.length > 0
    ? 'Both sides'
    : sideNames.get(days.left.length > 0 ? 'left' : 'right') ?? (days.left.length > 0 ? 'Left' : 'Right')
  const perLabel = new Map<string, number>()
  for (const g of groups.values()) perLabel.set(label(g.days), (perLabel.get(label(g.days)) ?? 0) + 1)

  for (const g of groups.values()) {
    const sorted = sortChronological(pointsToSetPoints(g.points))
    const days = normalizeDays(g.days)
    const reuse = curves.find(c => !c.active && !hasDays(curveDays(c)) && c.endAction === g.endAction && sameCurve(c.points, g.points))
    if (reuse) {
      tx.update(curveTemplates).set({ leftDays: days.left, rightDays: days.right, active: true }).where(eq(curveTemplates.id, reuse.id)).run()
      reuse.active = true
      continue
    }
    const base = label(days)
    const allDays = [...new Set([...days.left, ...days.right])]
    const name = uniqueName((perLabel.get(base) ?? 0) > 1 ? `${base} ${formatDayRange(allDays)}` : `${base} schedule`, taken)
    const now = new Date()
    tx.insert(curveTemplates).values({
      name,
      bedtime: sorted[0].time,
      wake: sorted[sorted.length - 1].time,
      points: g.points,
      notes: g.notes,
      endAction: g.endAction,
      leftDays: days.left,
      rightDays: days.right,
      active: true,
      createdAt: now,
      updatedAt: now,
    }).run()
  }
  return groups.size
}
