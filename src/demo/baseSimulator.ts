import type { DemoHandlers, RouterOutputs } from './types'
import { BASE_PRESETS, BASE_SIDES, INDEPENDENT_CONTROL_UNLOCKED, baseDayNumbers } from '@/src/hardware/base/types'
import type { BasePosition, BaseSide } from '@/src/hardware/base/types'

const WHOLE_BED_ONLY = 'This base supports whole-bed movement only'

/** A separate in-memory base for each debug session. Never opens hardware. */
export function createBaseSimulator({ independent = INDEPENDENT_CONTROL_UNLOCKED }: { independent?: boolean } = {}) {
  // A whole-bed base moves both halves together, so they start level with each other.
  const position: Record<BaseSide, BasePosition> = { left: { head: 30, feet: 15, feedRate: 50 }, right: independent ? { head: 1, feet: 5, feedRate: 50 } : { head: 30, feet: 15, feedRate: 50 } }
  const targets = structuredClone(position)
  const moving = { left: false, right: false }
  let updated = Date.now()
  let nextId = 1
  let schedules: RouterOutputs['base']['getSchedules'] = []
  const advance = () => {
    const elapsed = (Date.now() - updated) / 1000
    updated = Date.now()
    for (const side of BASE_SIDES) {
      if (!moving[side]) continue
      const step = elapsed * targets[side].feedRate / 15
      for (const part of ['head', 'feet'] as const) {
        const delta = targets[side][part] - position[side][part]
        position[side][part] += Math.sign(delta) * Math.min(Math.abs(delta), step)
      }
      moving[side] = position[side].head !== targets[side].head || position[side].feet !== targets[side].feet
    }
  }
  const status = (): RouterOutputs['base']['getStatus'] => {
    advance()
    const measured = (side: BaseSide) => ({ head: Math.round(position[side].head), feet: Math.round(position[side].feet) })
    return {
      state: 'connected', splitBase: true, independentControl: independent, position: { left: measured('left'), right: measured('right') },
      lastUpdate: Date.now(), stale: false, moving: moving.left || moving.right, movingBySide: { ...moving }, busy: false, error: null,
    }
  }
  const move = (input: BasePosition, sides: BaseSide[]) => {
    if (!independent && sides.length !== BASE_SIDES.length) throw new Error(WHOLE_BED_ONLY)
    advance()
    for (const side of sides) {
      targets[side] = { ...input }
      moving[side] = true
    }
    return { success: true as const }
  }
  return {
    getAvailability: () => ({ configured: true }),
    getStatus: status,
    reconnect: status,
    setPosition: input => move({ head: input.head, feet: input.feet, feedRate: input.feedRate ?? 50 }, input.sides ?? [...BASE_SIDES]),
    setPreset: input => move(BASE_PRESETS[input.preset], input.sides ?? [...BASE_SIDES]),
    stop: () => {
      advance()
      moving.left = false
      moving.right = false
      return { success: true }
    },
    getSchedules: () => schedules.map(row => ({ ...row })),
    saveSchedule: (input) => {
      const side = input.side ?? 'both'
      if (!independent && side !== 'both') throw new Error(WHOLE_BED_ONLY)
      if (schedules.some(row => row.id !== input.id && row.time === input.time && (row.side === side || row.side === 'both' || side === 'both') && baseDayNumbers(row.dayOfWeek).some(day => baseDayNumbers(input.dayOfWeek).includes(day)))) throw new Error('A base adjustment already exists for this side at this day and time')
      if (input.id !== undefined && !schedules.some(row => row.id === input.id)) throw new Error('Base schedule not found')
      const row = { ...input, side, presetName: input.presetName ?? 'Custom', feedRate: input.feedRate ?? 50, id: input.id ?? nextId++ }
      schedules = [...schedules.filter(s => s.id !== row.id), row]
      return row
    },
    deleteSchedule: (input) => {
      schedules = schedules.filter(row => row.id !== input.id)
      return { success: true }
    },
  } satisfies DemoHandlers<'base'>
}
