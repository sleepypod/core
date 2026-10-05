import type { DemoHandlers, RouterOutputs } from '../types'
import { BASE_PRESETS } from '@/src/hardware/base/types'
import type { BasePosition } from '@/src/hardware/base/types'

let position: BasePosition = { head: 1, feet: 5, feedRate: 50 }
let nextId = 1
let schedules: RouterOutputs['base']['getSchedules'] = []
const status = (): RouterOutputs['base']['getStatus'] => ({
  state: 'connected', splitBase: false, position: { left: { ...position }, right: { ...position } },
  lastUpdate: Date.now(), stale: false, moving: false, busy: false, error: null,
})
export const base: DemoHandlers<'base'> = {
  getStatus: status,
  reconnect: status,
  setPosition: (input) => {
    position = { ...input, feedRate: input.feedRate ?? 50 }
    return { success: true }
  },
  setPreset: (input) => {
    position = { ...BASE_PRESETS[input.preset] }
    return { success: true }
  },
  stop: () => ({ success: true }),
  getSchedules: () => schedules.map(row => ({ ...row })),
  saveSchedule: (input) => {
    if (schedules.some(row => row.id !== input.id && row.dayOfWeek === input.dayOfWeek && row.time === input.time)) throw new Error('A base adjustment already exists at this day and time')
    if (input.id !== undefined && !schedules.some(row => row.id === input.id)) throw new Error('Base schedule not found')
    const row = { ...input, feedRate: input.feedRate ?? 50, id: input.id ?? nextId++ }
    schedules = [...schedules.filter(s => s.id !== row.id), row]
    return row
  },
  deleteSchedule: (input) => {
    schedules = schedules.filter(row => row.id !== input.id)
    return { success: true }
  },
}
