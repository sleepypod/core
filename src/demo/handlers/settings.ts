import type { DemoHandlers, RouterOutputs } from '../types'
import { DAY } from '../util'

type Side = 'left' | 'right'
type AllSettings = RouterOutputs['settings']['getAll']
type DeviceSettings = AllSettings['device']
type SideSettings = AllSettings['sides']['left']
// The stored row: every optional column present (null when unused).
type Gesture = RouterOutputs['settings']['setGesture']

const createdAt = new Date(Date.now() - 45 * DAY)

const deviceSettings: DeviceSettings = {
  id: 1,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles',
  temperatureUnit: 'F',
  rebootDaily: true,
  rebootTime: '03:30',
  primePodDaily: true,
  primePodTime: '14:00',
  ledNightModeEnabled: true,
  ledDayBrightness: 80,
  ledNightBrightness: 10,
  ledNightStartTime: '21:30',
  ledNightEndTime: '07:00',
  globalMaxOnHours: 12,
  homekitEnabled: false,
  pumpStallProtectionEnabled: true,
  pumpStallRpmThreshold: 500,
  pumpStallDwellSamples: 2,
  pumpStallAutoRecoveryEnabled: true,
  pumpStallRecoveryRpm: 1500,
  pumpStallRecoverySamples: 3,
  createdAt,
  updatedAt: createdAt,
}

const sideSettings: Record<Side, SideSettings> = {
  left: { side: 'left', name: 'Alex', awayMode: false, alwaysOn: false, autoOffEnabled: true, autoOffMinutes: 30, awayStart: null, awayReturn: null, createdAt, updatedAt: createdAt },
  right: { side: 'right', name: 'Sam', awayMode: false, alwaysOn: false, autoOffEnabled: false, autoOffMinutes: 30, awayStart: null, awayReturn: null, createdAt, updatedAt: createdAt },
}

let nextGestureId = 1
const gesture = (g: Omit<Gesture, 'id' | 'createdAt' | 'updatedAt'>): Gesture =>
  ({ id: nextGestureId++, createdAt, updatedAt: createdAt, ...g })

let gestures: Gesture[] = [
  gesture({ side: 'left', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'decrement', temperatureAmount: 2, alarmBehavior: null, alarmSnoozeDuration: null, alarmInactiveBehavior: null }),
  gesture({ side: 'left', tapType: 'tripleTap', actionType: 'alarm', temperatureChange: null, temperatureAmount: null, alarmBehavior: 'snooze', alarmSnoozeDuration: 300, alarmInactiveBehavior: 'none' }),
  gesture({ side: 'right', tapType: 'doubleTap', actionType: 'temperature', temperatureChange: 'increment', temperatureAmount: 2, alarmBehavior: null, alarmSnoozeDuration: null, alarmInactiveBehavior: null }),
  gesture({ side: 'right', tapType: 'tripleTap', actionType: 'alarm', temperatureChange: null, temperatureAmount: null, alarmBehavior: 'dismiss', alarmSnoozeDuration: null, alarmInactiveBehavior: 'power' }),
]

export const settings: DemoHandlers<'settings'> = {
  getAll: () => ({
    device: { ...deviceSettings },
    sides: { left: { ...sideSettings.left }, right: { ...sideSettings.right } },
    gestures: {
      left: gestures.filter(g => g.side === 'left'),
      right: gestures.filter(g => g.side === 'right'),
    },
  }),

  updateDevice: (input) => {
    const { globalMaxOnHours, ...rest } = input
    Object.assign(deviceSettings, rest, { updatedAt: new Date() })
    if (globalMaxOnHours !== undefined) deviceSettings.globalMaxOnHours = globalMaxOnHours
    return { ...deviceSettings }
  },

  updateSide: (input) => {
    const { side, ...updates } = input
    const current = sideSettings[side]
    const alwaysOn = updates.alwaysOn ?? current.alwaysOn
    const autoOff = updates.autoOffEnabled ?? current.autoOffEnabled
    if (alwaysOn && autoOff) {
      throw new Error('alwaysOn and autoOffEnabled are mutually exclusive — set the other to false in the same call')
    }
    Object.assign(current, updates, { updatedAt: new Date() })
    return { ...current, awayStart: current.awayStart ?? null, awayReturn: current.awayReturn ?? null }
  },

  setAlwaysOn: (input) => {
    const current = sideSettings[input.side]
    Object.assign(current, { alwaysOn: input.alwaysOn, updatedAt: new Date() })
    return { ...current, awayStart: current.awayStart ?? null, awayReturn: current.awayReturn ?? null }
  },

  setGesture: (input) => {
    const blank = { temperatureChange: null, temperatureAmount: null, alarmBehavior: null, alarmSnoozeDuration: null, alarmInactiveBehavior: null }
    const existing = gestures.find(g => g.side === input.side && g.tapType === input.tapType)
    const now = new Date()
    if (existing) {
      Object.assign(existing, blank, input, { updatedAt: now })
      return { ...existing }
    }
    const created: Gesture = { id: nextGestureId++, ...blank, ...input, createdAt: now, updatedAt: now }
    gestures.push(created)
    return { ...created }
  },

  deleteGesture: (input) => {
    const before = gestures.length
    gestures = gestures.filter(g => !(g.side === input.side && g.tapType === input.tapType))
    if (gestures.length === before) throw new Error(`Gesture for ${input.side} ${input.tapType} not found`)
    return { success: true }
  },
}
