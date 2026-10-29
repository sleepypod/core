import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY, toCelsius } from '../util'
import { planCurveSave } from '@/src/lib/sleepCurve/savePlan'
import { releaseDemoDays } from './curveTemplates'

type Side = 'left' | 'right'
type Collection = RouterOutputs['schedules']['getAll']
type TempRow = Collection['temperature'][number]
type PowerRow = Collection['power'][number]
type AlarmRow = Collection['alarm'][number]
type DayOfWeek = TempRow['dayOfWeek']

export const WEEKNIGHTS: DayOfWeek[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday']
export const WEEKEND_NIGHTS: DayOfWeek[] = ['friday', 'saturday']
const WEEKDAYS: DayOfWeek[] = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday']

const createdAt = new Date(Date.now() - 30 * DAY)
let nextId = 1

let temperature: TempRow[] = []
let power: PowerRow[] = []
let alarm: AlarmRow[] = []
// Curve notes keyed "side:day".
const notes = new Map<string, string>()

/** Night set points belong to the evening's day, post-midnight times included. */
export const CURVES: Record<Side, { weeknight: [string, number][], weekend: [string, number][] }> = {
  left: {
    weeknight: [['22:00', 72], ['22:30', 68], ['01:00', 66], ['04:00', 69], ['06:00', 74]],
    weekend: [['23:00', 72], ['23:30', 68], ['02:00', 66], ['05:00', 69], ['07:30', 75]],
  },
  right: {
    weeknight: [['22:00', 80], ['22:30', 77], ['01:00', 76], ['04:00', 78], ['06:30', 82]],
    weekend: [['23:00', 80], ['23:30', 77], ['02:00', 76], ['05:00', 78], ['08:00', 82]],
  },
}

function seed() {
  const meta = { enabled: true, createdAt, updatedAt: createdAt }
  for (const side of ['left', 'right'] as const) {
    for (const [days, curve] of [[WEEKNIGHTS, CURVES[side].weeknight], [WEEKEND_NIGHTS, CURVES[side].weekend]] as const) {
      for (const dayOfWeek of days) {
        for (const [time, temp] of curve) temperature.push({ id: nextId++, side, dayOfWeek, time, temperature: temp, ...meta })
        const weekend = WEEKEND_NIGHTS.includes(dayOfWeek)
        power.push({
          id: nextId++, side, dayOfWeek,
          onTime: weekend ? '22:45' : '21:45',
          offTime: weekend ? '08:30' : '07:00',
          endAction: 'turn_off',
          onTemperature: curve[0][1],
          ...meta,
        })
      }
    }
  }
  for (const dayOfWeek of WEEKDAYS) {
    alarm.push({ id: nextId++, side: 'left', dayOfWeek, time: '06:45', vibrationIntensity: 60, vibrationPattern: 'rise', duration: 30, alarmTemperature: 78, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, ...meta })
    alarm.push({ id: nextId++, side: 'right', dayOfWeek, time: '07:15', vibrationIntensity: 40, vibrationPattern: 'double', duration: 20, alarmTemperature: 84, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, ...meta })
  }
  alarm.push({ id: nextId++, side: 'right', dayOfWeek: 'saturday', time: '08:30', vibrationIntensity: 30, vibrationPattern: 'rise', duration: 20, alarmTemperature: 84, wakeWindow: 0, snoozeDuration: 300, snoozeTaper: 0, ...meta, enabled: false })
}
seed()

function collection(side: Side, unit: 'F' | 'C' = 'F', day?: DayOfWeek): Collection {
  const match = (r: { side: Side, dayOfWeek: DayOfWeek }) => r.side === side && (day === undefined || r.dayOfWeek === day)
  const c = (f: number) => (unit === 'C' ? toCelsius(f) : f)
  return {
    temperature: temperature.filter(match).map(r => ({ ...r, temperature: c(r.temperature) })),
    power: power.filter(match).map(r => ({ ...r, onTemperature: c(r.onTemperature) })),
    alarm: alarm.filter(match).map(r => ({ ...r, alarmTemperature: c(r.alarmTemperature) })),
  }
}

/** True when a row update changes more than its enabled flag. */
function editsRow(changes: Record<string, unknown>): boolean {
  return Object.entries(changes).some(([key, value]) => key !== 'id' && key !== 'enabled' && value !== undefined)
}

function update<T extends { id: number, updatedAt: Date }>(rows: T[], kind: string, id: number, changes: Partial<T>): T {
  const row = rows.find(r => r.id === id)
  if (!row) throw new Error(`${kind} schedule with ID ${id} not found`)
  Object.assign(row, Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)), { updatedAt: new Date() })
  return { ...row }
}

function remove<T extends { id: number }>(rows: T[], kind: string, id: number): T[] {
  if (!rows.some(r => r.id === id)) throw new Error(`${kind} schedule with ID ${id} not found`)
  return rows.filter(r => r.id !== id)
}

const stamp = () => {
  const now = new Date()
  return { id: nextId++, createdAt: now, updatedAt: now }
}

/** Write a library curve's rows on one side, as src/server/scheduleLibrary.ts does on the pod. */
export function writeDemoCurveRows(side: Side, targetDays: DayOfWeek[], clearDays: DayOfWeek[], curve: {
  points: Record<string, number>
  endAction: 'turn_off' | 'maintain'
  notes: string
}) {
  const plan = planCurveSave({
    sides: [side],
    targetDays,
    clearDays,
    setPoints: Object.entries(curve.points).map(([time, temp]) => ({ time, temperature: temp })),
    endAction: curve.endAction,
    notes: curve.notes,
    existing: { temperature: temperature.filter(r => r.side === side), power: power.filter(r => r.side === side) },
  })
  const deleted = { temperature: new Set(plan.deletes.temperature), power: new Set(plan.deletes.power) }
  temperature = temperature.filter(r => !deleted.temperature.has(r.id))
  power = power.filter(r => !deleted.power.has(r.id))
  for (const c of plan.creates.temperature) temperature.push({ ...c, ...stamp() })
  for (const c of plan.creates.power) power.push({ ...c, ...stamp() })
  for (const n of plan.notes) {
    if (n.notes) notes.set(`${n.side}:${n.dayOfWeek}`, n.notes)
    else notes.delete(`${n.side}:${n.dayOfWeek}`)
  }
}

export const schedules: DemoHandlers<'schedules'> = {
  getAll: input => collection(input.side, input.unit),

  getByDay: input => collection(input.side, input.unit, input.dayOfWeek),

  getNotes: input => [...notes].filter(([key]) => key.startsWith(`${input.side}:`))
    .map(([key, text]) => ({ dayOfWeek: key.split(':')[1] as DayOfWeek, notes: text })),

  createTemperatureSchedule: (input) => {
    const row: TempRow = { ...input, enabled: input.enabled ?? true, ...stamp() }
    temperature.push(row)
    releaseDemoDays([row])
    return { ...row }
  },
  updateTemperatureSchedule: ({ id, ...changes }) => {
    const row = update(temperature, 'Temperature', id, changes)
    if (editsRow(changes)) releaseDemoDays([row])
    return row
  },
  deleteTemperatureSchedule: (input) => {
    releaseDemoDays(temperature.filter(r => r.id === input.id))
    temperature = remove(temperature, 'Temperature', input.id)
    return { success: true }
  },

  createPowerSchedule: (input) => {
    const row: PowerRow = { ...input, endAction: input.endAction ?? 'turn_off', enabled: input.enabled ?? true, ...stamp() }
    power.push(row)
    releaseDemoDays([row])
    return { ...row }
  },
  updatePowerSchedule: ({ id, ...changes }) => {
    const row = update(power, 'Power', id, changes)
    if (editsRow(changes)) releaseDemoDays([row])
    return row
  },
  deletePowerSchedule: (input) => {
    releaseDemoDays(power.filter(r => r.id === input.id))
    power = remove(power, 'Power', input.id)
    return { success: true }
  },

  createAlarmSchedule: (input) => {
    const row: AlarmRow = { ...input, vibrationPattern: input.vibrationPattern ?? 'rise', wakeWindow: input.wakeWindow ?? 0, snoozeDuration: input.snoozeDuration ?? 300, snoozeTaper: input.snoozeTaper ?? 0, enabled: input.enabled ?? true, ...stamp() }
    alarm.push(row)
    return { ...row }
  },
  updateAlarmSchedule: ({ id, ...changes }) => update(alarm, 'Alarm', id, changes),
  deleteAlarmSchedule: (input) => {
    alarm = remove(alarm, 'Alarm', input.id)
    return { success: true }
  },

  batchUpdate: (input) => {
    // Validate every id first so a bad batch leaves state untouched, like the real transaction.
    const missing = (rows: { id: number }[], ids: number[] = []) => ids.find(id => !rows.some(r => r.id === id))
    const bad = missing(temperature, input.deletes?.temperature) ?? missing(power, input.deletes?.power) ?? missing(alarm, input.deletes?.alarm)
      ?? missing(temperature, input.updates?.temperature?.map(u => u.id)) ?? missing(power, input.updates?.power?.map(u => u.id))
      ?? missing(alarm, input.updates?.alarm?.map(u => u.id))
    if (bad !== undefined) throw new Error(`Schedule with ID ${bad} not found`)

    const edited = [
      ...temperature.filter(r => input.deletes?.temperature?.includes(r.id)),
      ...power.filter(r => input.deletes?.power?.includes(r.id)),
      ...(input.creates?.temperature ?? []),
      ...(input.creates?.power ?? []),
      ...temperature.filter(r => input.updates?.temperature?.some(u => u.id === r.id && editsRow(u))),
      ...power.filter(r => input.updates?.power?.some(u => u.id === r.id && editsRow(u))),
    ]
    for (const id of input.deletes?.temperature ?? []) temperature = remove(temperature, 'Temperature', id)
    for (const id of input.deletes?.power ?? []) power = remove(power, 'Power', id)
    for (const id of input.deletes?.alarm ?? []) alarm = remove(alarm, 'Alarm', id)

    for (const c of input.creates?.temperature ?? []) temperature.push({ ...c, enabled: c.enabled ?? true, ...stamp() })
    for (const c of input.creates?.power ?? []) power.push({ ...c, endAction: c.endAction ?? 'turn_off', enabled: c.enabled ?? true, ...stamp() })
    for (const c of input.creates?.alarm ?? []) alarm.push({ ...c, vibrationPattern: c.vibrationPattern ?? 'rise', wakeWindow: c.wakeWindow ?? 0, snoozeDuration: c.snoozeDuration ?? 300, snoozeTaper: c.snoozeTaper ?? 0, enabled: c.enabled ?? true, ...stamp() })

    for (const { id, ...changes } of input.updates?.temperature ?? []) update(temperature, 'Temperature', id, changes)
    for (const { id, ...changes } of input.updates?.power ?? []) update(power, 'Power', id, changes)
    for (const { id, ...changes } of input.updates?.alarm ?? []) update(alarm, 'Alarm', id, changes)

    for (const n of input.notes ?? []) {
      const text = n.notes?.trim()
      if (text) notes.set(`${n.side}:${n.dayOfWeek}`, text)
      else notes.delete(`${n.side}:${n.dayOfWeek}`)
    }
    releaseDemoDays(edited)

    return { success: true }
  },
}
