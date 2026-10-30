import { vi } from 'vitest'
import type { ControlDispatchScope } from '../context'

export function testScope(): ControlDispatchScope {
  return { issuedAt: 100, expiresAt: 200, monotonicDeadline: 100, now: () => 100, monotonicNow: () => 0, beforeDispatch: vi.fn(), dispatchCount: 0, deadlineRejected: false, closed: false }
}
