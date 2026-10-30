import { AsyncLocalStorage } from 'node:async_hooks'

export interface ControlDispatchScope {
  issuedAt: number
  expiresAt: number
  monotonicDeadline: number
  now: () => number
  monotonicNow: () => number
  beforeDispatch: (at: number) => void
  dispatchCount: number
  deadlineRejected: boolean
  closed: boolean
}

interface DispatchGuard { check: () => void, closed: boolean }
const globals = globalThis as typeof globalThis & {
  __sp_controlScope?: AsyncLocalStorage<ControlDispatchScope>
  __sp_dispatchGuards?: AsyncLocalStorage<DispatchGuard[]>
}
const storage = globals.__sp_controlScope ??= new AsyncLocalStorage<ControlDispatchScope>()
const guards = globals.__sp_dispatchGuards ??= new AsyncLocalStorage<DispatchGuard[]>()

export class ControlGuardError extends Error {
  constructor() {
    super('Current control conditions no longer permit this write')
    this.name = 'ControlGuardError'
  }
}

function assertDispatchGuards(): void {
  for (const guard of guards.getStore() ?? []) {
    if (guard.closed) throw new ControlGuardError()
    guard.check()
  }
}

/** Compose policy checks with existing request deadlines at every actual FIFO write. */
export async function withinDispatchGuard<T>(check: () => void, execute: () => Promise<T>): Promise<T> {
  const guard = { check, closed: false }
  return guards.run([...(guards.getStore() ?? []), guard], async () => {
    try {
      assertDispatchGuards()
      return await execute()
    }
    finally { guard.closed = true }
  })
}

export class ControlDeadlineError extends Error {
  constructor() {
    super('Control request expired before dispatch')
    this.name = 'ControlDeadlineError'
  }
}

/** Recheck after queue waits, including a wall-clock rollback during the request. */
export function assertControlDeadline(): void {
  const scope = storage.getStore()
  if (!scope) return
  const now = scope.now()
  if (scope.closed || now < scope.issuedAt || now >= scope.expiresAt || scope.monotonicNow() >= scope.monotonicDeadline) {
    scope.deadlineRejected = true
    throw new ControlDeadlineError()
  }
}

/** Check before persisting intent as well as at the later hardware dispatch. */
export function assertControlCurrent(): void {
  assertControlDeadline()
  assertDispatchGuards()
}

/** Count only writes belonging to this request, never another queued caller. */
export function getControlDispatchCount(): number {
  return storage.getStore()?.dispatchCount ?? 0
}

/** Persist the dispatch barrier before a byte can leave this process. */
export function beforeControlWrite(): void {
  assertDispatchGuards()
  const scope = storage.getStore()
  if (!scope) return
  assertControlDeadline()
  scope.beforeDispatch(scope.now())
  scope.dispatchCount++
  // A contended SQLite commit can itself outlast the request's lifetime.
  assertControlDeadline()
  assertDispatchGuards()
}

export async function withinControlRequest<T>(scope: ControlDispatchScope, execute: () => Promise<T>): Promise<T> {
  return storage.run(scope, async () => {
    try {
      assertControlDeadline()
      return await execute()
    }
    finally {
      scope.closed = true
    }
  })
}

/** Long-lived schedulers must not inherit the request that first initializes them. */
export function outsideControlRequest<T>(execute: () => T): T {
  return storage.exit(() => guards.exit(execute))
}
