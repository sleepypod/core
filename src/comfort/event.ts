import type { ComfortEvent } from './contract'

export function comfortEvent(at: number, kind: ComfortEvent['kind'], message: string): ComfortEvent {
  return { at, kind, message, session: null, proposedF: null, reportedF: null, eligible: false,
    deviceObservedAt: null, presenceObservedAt: null, owner: null }
}
