import { sqlite } from '@/src/db'
import { createAlarmStore } from './store'

/** Factory is inert: API reads never initialize the scheduler or DAC. */
export function alarmStore() {
  return createAlarmStore(sqlite)
}
