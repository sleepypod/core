import type { Side } from '@/src/hardware/types'
import type { LaterAlarmPreview, NextAlarmWrite } from './contract'
import type { createAlarmStore } from './store'

export async function changeNextAlarm(input: NextAlarmWrite, deps: {
  store: ReturnType<typeof createAlarmStore>
  now(): number
  withSideLock<Result>(side: Side, work: () => Promise<Result>): Promise<Result>
  synchronize(side: Side): Promise<boolean>
}) {
  const saved = await deps.withSideLock(input.side, async () => deps.store.write(input, deps.now()))
  // Persist first, then register the new timer without holding a hardware lock.
  // A lost response is reconciled with GET, never by blindly replaying a write.
  const schedulerUpdated = await deps.synchronize(input.side)
  return { ...saved, schedulerUpdated }
}

/** Apply only the exact, unexpired plan that the user reviewed. */
export async function applyLaterAlarm(preview: LaterAlarmPreview, deps: {
  store: ReturnType<typeof createAlarmStore>
  now(): number
  withSideLock<Result>(side: Side, work: () => Promise<Result>): Promise<Result>
  synchronize(side: Side): Promise<boolean>
}) {
  const saved = await deps.withSideLock(preview.before.side, async () => deps.store.applyLater(preview, deps.now()))
  const schedulerUpdated = await deps.synchronize(preview.before.side)
  return { ...saved, schedulerUpdated }
}
