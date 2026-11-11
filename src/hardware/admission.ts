import { AsyncLocalStorage } from 'node:async_hooks'

export interface HardwareAdmissionSnapshot {
  revision: number
  holdId: string | null
}
interface AdmissionSource { read: () => HardwareAdmissionSnapshot }
interface Intent { runtime: object | null, revision: number | null }
interface Runtime {
  source: AdmissionSource
  active: number
  waiters: Set<() => void>
  observed?: HardwareAdmissionSnapshot
  blockedUntilRestart?: boolean
}
const shared = globalThis as typeof globalThis & {
  __sp_hardwareAdmission?: Runtime
  __sp_hardwareIntent?: AsyncLocalStorage<Intent>
}
const intents = shared.__sp_hardwareIntent ??= new AsyncLocalStorage<Intent>()

export class HardwareAdmissionError extends Error {
  constructor() {
    super('Hardware changes are paused or this command belongs to an earlier arrangement. Refresh the current state.')
    this.name = 'HardwareAdmissionError'
  }
}

/** Install after migrations and before any actuator starts. No source means closed. */
export function installHardwareAdmission(source: AdmissionSource): () => void {
  if (shared.__sp_hardwareAdmission) throw new Error('Hardware admission is already installed')
  const runtime: Runtime = { source, active: 0, waiters: new Set() }
  shared.__sp_hardwareAdmission = runtime
  return () => {
    if (runtime.active > 0) throw new Error('Hardware writes have not drained')
    if (shared.__sp_hardwareAdmission === runtime) delete shared.__sp_hardwareAdmission
  }
}

function read(runtime: Runtime): HardwareAdmissionSnapshot {
  try {
    const snapshot = runtime.source.read()
    if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1
      || (snapshot.holdId !== null && (typeof snapshot.holdId !== 'string' || !snapshot.holdId))) throw new Error('Invalid admission state')
    const previous = runtime.observed
    if (previous && (snapshot.revision < previous.revision
      || (snapshot.revision === previous.revision && snapshot.holdId !== previous.holdId))) throw new Error('Admission state moved backwards')
    runtime.observed = { ...snapshot }
    return snapshot
  }
  catch { throw new HardwareAdmissionError() }
}

/** Capture before queue/connection waits; an unreadable source never becomes a fresh intent later. */
export function captureHardwareIntent(): Intent {
  const inherited = intents.getStore()
  if (inherited) return inherited
  const runtime = shared.__sp_hardwareAdmission
  if (!runtime) return { runtime: null, revision: null }
  if (runtime.blockedUntilRestart) return { runtime, revision: null }
  try {
    const snapshot = read(runtime)
    return { runtime, revision: snapshot.holdId === null ? snapshot.revision : null }
  }
  catch { return { runtime, revision: null } }
}

/** Keep a multi-command operation on the revision it started with, including delayed motor writes. */
export function withinHardwareIntent<Result>(operation: () => Result): Result {
  return intents.run(captureHardwareIntent(), operation)
}

export function outsideHardwareIntent<Result>(operation: () => Result): Result {
  return intents.exit(operation)
}

/** Recheck again after synchronous bookkeeping; it can itself change the current hold. */
export function assertHardwareWriteCurrent(intent: Intent, stopping = false): void {
  const runtime = shared.__sp_hardwareAdmission
  if (!stopping) {
    if (!runtime || runtime.blockedUntilRestart || intent.runtime !== runtime || intent.revision === null) throw new HardwareAdmissionError()
    const snapshot = read(runtime)
    if (snapshot.holdId !== null || snapshot.revision !== intent.revision) throw new HardwareAdmissionError()
  }
}

/** If a partial runtime cannot be drained, reject its old and new writes until a clean process starts. Stop remains available. */
export function blockHardwareUntilRestart(): void {
  const runtime = shared.__sp_hardwareAdmission
  if (runtime) runtime.blockedUntilRestart = true
}

/** Recheck durable admission at actual dispatch and retain in-flight writes through their reply. */
export function beginHardwareWrite(intent: Intent, stopping = false): () => void {
  assertHardwareWriteCurrent(intent, stopping)
  const runtime = shared.__sp_hardwareAdmission
  // Explicit Stop remains possible even before initialization or after storage fails.
  if (!runtime) return () => {}
  runtime.active++
  let finished = false
  return () => {
    if (finished) return
    finished = true
    runtime.active--
    if (runtime.active === 0) for (const waiter of [...runtime.waiters]) waiter()
  }
}

/** Caller must persist a hold first. Timeout leaves the hold intact; it never reopens admission. */
export async function waitForHardwareDrain(holdId: string, timeoutMs = 10_000): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new RangeError('Invalid drain timeout')
  const runtime = shared.__sp_hardwareAdmission
  const verify = () => {
    if (!runtime || shared.__sp_hardwareAdmission !== runtime || read(runtime).holdId !== holdId || !holdId)
      throw new HardwareAdmissionError()
  }
  verify()
  if (!runtime || runtime.active === 0) return
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer)
      runtime.waiters.delete(finish)
      try {
        verify()
        resolve()
      }
      catch (error) { reject(error) }
    }
    const timer = setTimeout(() => {
      runtime.waiters.delete(finish)
      reject(new Error('Hardware writes did not finish before the drain deadline'))
    }, timeoutMs)
    runtime.waiters.add(finish)
  })
  verify()
  if (runtime.active !== 0) throw new Error('A Stop command is still completing; keep admission held and check again')
}

/** Recheck inside the synchronous configuration transaction after the asynchronous drain. */
export function assertHardwareDrained(holdId: string, expectedRevision: number): void {
  const runtime = shared.__sp_hardwareAdmission
  if (!runtime || runtime.active !== 0) throw new HardwareAdmissionError()
  const current = read(runtime)
  if (!holdId || current.holdId !== holdId || current.revision !== expectedRevision) throw new HardwareAdmissionError()
}

/** Match the complete wire message. Neutral temperature is not a power-off command. */
export function classifyDacAdmission(message: string): 'read' | 'stop' | 'change' {
  if (message === '0' || message === '14') return 'read'
  if (/^(?:9|10)\n0$/.test(message) || /^16\n[01]$/.test(message)) return 'stop'
  return 'change'
}
