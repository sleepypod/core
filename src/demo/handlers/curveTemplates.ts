import type { DemoHandlers, RouterOutputs } from '../types'
import { hasDays, LIBRARY_SIDES, type LibrarySide, movedDays, normalizeDays, planClaims } from '@/src/lib/scheduleLibrary'
import type { DayOfWeek } from '@/src/lib/scheduleTime'
import { CURVES, WEEKEND_NIGHTS, WEEKNIGHTS, writeDemoCurveRows } from './schedules'

type Template = RouterOutputs['curveTemplates']['list'][number]

const templates: Template[] = []
let nextId = 1
let seeded = false

/** The demo schedules as library curves, plus one that is saved but off. Seeded lazily: schedules.ts imports this module. */
function library(): Template[] {
  if (seeded) return templates
  seeded = true
  const at = new Date(Date.now() - 30 * 24 * 3600_000)
  const add = (name: string, side: LibrarySide | null, days: DayOfWeek[], points: [string, number][], notes = '') => {
    const p = Object.fromEntries(points)
    templates.push({
      id: nextId++, name, bedtime: points[0][0], wake: points[points.length - 1][0], points: p, notes, endAction: 'turn_off',
      days: normalizeDays(side ? { [side]: days } : {}), active: side !== null, createdAt: at, updatedAt: at,
    })
  }
  add('Cool weeknights', 'left', WEEKNIGHTS, CURVES.left.weeknight)
  add('Cool weekends', 'left', WEEKEND_NIGHTS, CURVES.left.weekend)
  add('Warm weeknights', 'right', WEEKNIGHTS, CURVES.right.weeknight)
  add('Warm weekends', 'right', WEEKEND_NIGHTS, CURVES.right.weekend)
  add('Heatwave', null, [], [['22:00', 66], ['23:00', 62], ['03:00', 64], ['06:30', 72]], 'Colder all night for hot summer weeks.')
  return templates
}

/** Write `curve`'s rows after a change, clearing days it held `before`. */
function sync(curve: Template, before: { days: Template['days'], active: boolean } | null) {
  for (const side of LIBRARY_SIDES) {
    const target = curve.active ? curve.days[side] : []
    const clear = before?.active ? before.days[side] : []
    if (target.length > 0 || clear.length > 0) writeDemoCurveRows(side, target, clear, curve)
  }
}

function claim(target: Template, before: { days: Template['days'], active: boolean } | null) {
  const plan = planClaims(library(), target.id, target.days, target.active)
  for (const u of plan.updates) {
    const other = templates.find(t => t.id === u.id)
    if (other) Object.assign(other, { days: u.days, active: u.active })
  }
  sync(target, before)
  return { curve: { ...target }, moved: movedDays(plan.moves) }
}

/** Rows edited one by one leave the library curve that claimed their day (see releaseDays on the server). */
export function releaseDemoDays(rows: Array<{ side: LibrarySide, dayOfWeek: DayOfWeek }>) {
  for (const t of library()) {
    if (!t.active) continue
    const days = { left: [...t.days.left], right: [...t.days.right] }
    for (const r of rows) days[r.side] = days[r.side].filter(d => d !== r.dayOfWeek)
    if (days.left.length !== t.days.left.length || days.right.length !== t.days.right.length) {
      Object.assign(t, { days, active: hasDays(days) })
    }
  }
}

export const curveTemplates: DemoHandlers<'curveTemplates'> = {
  list: () => [...library()].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()),

  save: (input) => {
    const now = new Date()
    const existing = library().find(t => t.name === input.name)
    if (existing) {
      const before = { days: existing.days, active: existing.active }
      Object.assign(existing, { ...input, endAction: input.endAction ?? existing.endAction, notes: input.notes ?? '', updatedAt: now })
      if (existing.active) sync(existing, before)
      return existing
    }
    const created: Template = {
      id: nextId++, ...input, endAction: input.endAction ?? 'turn_off', notes: input.notes ?? '',
      days: { left: [], right: [] }, active: false, createdAt: now, updatedAt: now,
    }
    templates.push(created)
    return created
  },

  put: (input) => {
    const now = new Date()
    const days = normalizeDays(input.days)
    const existing = input.id === undefined ? undefined : library().find(t => t.id === input.id)
    if (input.id !== undefined && !existing) throw new Error(`No curve with id ${input.id}`)
    if (library().some(t => t.name === input.name && t.id !== input.id)) throw new Error('Another curve already has that name')
    const fields = {
      name: input.name, bedtime: input.bedtime, wake: input.wake, points: input.points, notes: input.notes ?? '',
      endAction: input.endAction ?? 'turn_off', days, active: input.active && hasDays(days), updatedAt: now,
    }
    if (existing) {
      const before = { days: existing.days, active: existing.active }
      Object.assign(existing, fields)
      return claim(existing, before)
    }
    const created: Template = { id: nextId++, ...fields, createdAt: now }
    templates.push(created)
    return claim(created, null)
  },

  setActive: (input) => {
    const t = library().find(c => c.id === input.id)
    if (!t) throw new Error(`No curve with id ${input.id}`)
    if (input.active && !hasDays(t.days)) throw new Error(`Pick days for ${t.name} before turning it on`)
    if (t.active === input.active) return { curve: { ...t }, moved: [] }
    const before = { days: t.days, active: t.active }
    t.active = input.active
    return claim(t, before)
  },

  delete: (input) => {
    const i = library().findIndex(t => t.name === input.name)
    if (i >= 0) {
      const [t] = templates.splice(i, 1)
      if (t.active) sync({ ...t, active: false }, { days: t.days, active: true })
    }
    return { deleted: i >= 0 }
  },
}
