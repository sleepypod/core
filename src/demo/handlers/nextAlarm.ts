import type { DemoHandlers } from '../types'

function unavailable(): never {
  throw new Error('One-time alarms require a live, authenticated Pod. No wake time was changed in this demo.')
}
export const nextAlarm: DemoHandlers<'nextAlarm'> = { get: unavailable, change: unavailable }
