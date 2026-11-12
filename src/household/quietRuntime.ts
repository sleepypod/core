import { sqlite } from '@/src/db'
import { BaseError } from '@/src/hardware/base/types'
import { HouseholdStore } from './store'
import { HouseholdQuietStore } from './quiet'

const shared = globalThis as typeof globalThis & { __sleepypodHouseholdQuiet?: HouseholdQuietStore }
export function getHouseholdQuiet() {
  return shared.__sleepypodHouseholdQuiet ??= new HouseholdQuietStore(sqlite, new HouseholdStore(sqlite))
}

/** Stop bypasses this guard; every new head/feet write must observe current shared intent. */
export function assertSharedBaseMovementAllowed() {
  let paused: boolean
  try {
    paused = getHouseholdQuiet().sharedState().paused
  }
  catch { throw new BaseError('unavailable', 'Quiet status is unavailable. Refresh it before moving the shared base.') }
  if (paused) throw new BaseError('unavailable', 'Shared base movement is paused while someone is resting. Stop is still available.')
}
