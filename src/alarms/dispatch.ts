import { withinControlRequest, type ControlDispatchScope } from '@/src/controls/context'
import type { Side } from '@/src/hardware/types'
import type { AlarmOccurrence } from './model'
import type { createAlarmStore } from './store'

/** The DAC queue checks expiry and current ownership again immediately before writing bytes. */
export async function dispatchAlarm(store: ReturnType<typeof createAlarmStore>, side: Side, candidate: AlarmOccurrence, early: boolean, send: () => Promise<void>) {
  const issuedAt = Date.now()
  const expiresAt = Math.min(candidate.at + 60_000, issuedAt + 60_000)
  const scope: ControlDispatchScope = {
    issuedAt, expiresAt, now: Date.now, monotonicNow: () => performance.now(),
    monotonicDeadline: performance.now() + Math.max(0, expiresAt - issuedAt),
    dispatchCount: 0, deadlineRejected: false, closed: false,
    beforeDispatch: (now) => {
      if (scope.dispatchCount !== 0 || !store.dispatchable(side, candidate, now, early)) throw new Error('Alarm occurrence changed or was already dispatched; it will not be replayed.')
    },
  }
  return withinControlRequest(scope, send)
}
