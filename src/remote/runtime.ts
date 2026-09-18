import { eq } from 'drizzle-orm'
import { db, sqlite } from '@/src/db'
import { automations, deviceState, sideSettings } from '@/src/db/schema'
import { onServerFrame } from '@/src/streaming/piezoStream'
import { getAutomationEngine } from '@/src/automation'
import { shouldBlock } from '@/src/hardware/pumpStallGuard'
import { executeRemoteAction, type RemoteActionDeps } from './actions'
import { RemoteRecognizer } from './recognizer'
import { RemoteStore } from './store'
import { inputSchema, type Detection } from './model'
export const remoteStore = new RemoteStore(sqlite)
// Instrumentation and route handlers can be separate Next.js module graphs.
// Share the live dispatcher, queue and SSE subscribers across those graphs.
interface RuntimeState {
  listeners: Set<(event: Detection) => void>
  unsubscribe?: () => void
  recognizer?: RemoteRecognizer
  pending: Promise<void>
  queued: number
  running: boolean
  latest: Detection | null
  lastError: string | null
}
const runtimeGlobal = globalThis as typeof globalThis & { __sleepypodRemote?: RuntimeState }
const runtimeState = runtimeGlobal.__sleepypodRemote ??= {
  listeners: new Set(), pending: Promise.resolve(), queued: 0,
  running: false, latest: null, lastError: null,
} as RuntimeState
const deps: RemoteActionDeps = {
  /** Read current device state for relative actions; reject unavailable state. */
  async state(side) {
    const row = db.select().from(deviceState).where(eq(deviceState.side, side)).get()

    if (!row)
      throw new Error('Device state unavailable')

    return row
  },
  /** Read the persisted away mode before toggling it. */
  async away(side) {
    const row = db.select().from(sideSettings).where(eq(sideSettings.side, side)).get()

    if (!row)
      throw new Error('Side settings unavailable')

    return row.awayMode
  },
  /** Delegate temperature changes to the existing manual-control procedure. */
  async setTemperature(side, temperature) {
    return (await caller()).device.setTemperature({ side, temperature })
  },
  /** Delegate side power changes to the existing manual-control procedure. */
  async setPower(side, powered) {
    return (await caller()).device.setPower({ side, powered })
  },
  /** Dismiss the side alarm through the device API. */
  async clearAlarm(side) {
    return (await caller()).device.clearAlarm({ side })
  },
  /** Snooze the side alarm for the validated duration in seconds. */
  async snoozeAlarm(side, duration) {
    return (await caller()).device.snoozeAlarm({ side, duration })
  },
  /** Persist the requested side away mode through settings. */
  async setAway(side, awayMode) {
    return (await caller()).settings.updateSide({ side, awayMode })
  },
  /** Start priming only when neither side is blocked by the pump safety interlock. */
  async prime() {
    if (shouldBlock('left') || shouldBlock('right'))
      throw new Error('Priming blocked by pump safety interlock')

    return (await caller()).device.startPriming({})
  },
  /** Reject deleted rules and evaluate a manual run through the shared automation engine. */
  async runAutomation(id) {
    if (!db.select({ id: automations.id }).from(automations).where(eq(automations.id, id)).get())
      throw new Error('Automation no longer exists')

    await (await getAutomationEngine()).runNow(id)
  },
}
// Lazy import avoids the appRouter -> remote -> appRouter initialization cycle.
/** Load the manual-control router lazily to avoid its initialization cycle with the remote runtime. */
async function caller() {
  return (await import('@/src/server/routers/app')).appRouter.createCaller({})
}
/** Store the latest outcome and notify subscribers without letting a failed subscriber interrupt dispatch. */
function publish(event: Detection) {
  runtimeState.latest = event

  for (const listener of runtimeState.listeners) {
    try {
      listener(event)
    }
    catch {
      /* disconnected subscriber */
    }
  }
}
/** Queue a detection with bounded backlog and age, resolving its binding when execution starts. */
function handle(event: Detection) {
  publish({ ...event, outcome: 'Detected' })

  if (runtimeState.queued >= 20) {
    publish({ ...event, outcome: 'Skipped: command queue full' })

    return
  }

  runtimeState.queued++

  runtimeState.pending = runtimeState.pending.then(async () => {
    if (!runtimeState.running || Date.now() - event.receivedAt > 5000) {
      publish({ ...event, outcome: 'Skipped: stale detection' })

      return
    }

    const input = inputSchema.safeParse(event.inputId)

    if (event.gesture === 'unsupported' || !input.success) {
      publish({ ...event, outcome: event.detail ?? 'Unsupported gesture' })

      return
    }

    const binding = remoteStore.read()[event.side][input.data]

    const outcome = binding ? await executeRemoteAction(binding, event.side, deps) : 'Firmware default (no software override)'

    publish({ ...event, outcome })
  }).catch((error: unknown) => {
    runtimeState.lastError = error instanceof Error ? error.message : String(error)

    publish({ ...event, outcome: `Failed: ${runtimeState.lastError}` })

    console.warn('[remote]', runtimeState.lastError)
  }).finally(() => {
    runtimeState.queued--
  })
}
/** Validate persistence and attach one process-wide recognizer to live server frames. */
export function startRemoteRuntime() {
  if (runtimeState.running)
    return

  // Validate persistence before enabling hardware actions.

  remoteStore.read()

  runtimeState.running = true

  runtimeState.recognizer = new RemoteRecognizer(handle)

  runtimeState.unsubscribe = onServerFrame(frame => runtimeState.recognizer?.feed(frame))
}
/** Detach recognition, skip pending work, drain any active command, and clear subscribers. */
export async function stopRemoteRuntime() {
  runtimeState.running = false

  runtimeState.unsubscribe?.()

  runtimeState.unsubscribe = undefined

  runtimeState.recognizer?.stop()

  runtimeState.recognizer = undefined

  await runtimeState.pending

  runtimeState.listeners.clear()
}
/** Subscribe to live detection outcomes and return an idempotent unsubscribe function. */
export function subscribeRemote(listener: (event: Detection) => void) {
  runtimeState.listeners.add(listener)

  return () => {
    runtimeState.listeners.delete(listener)
  }
}
/** Return the shared runtime health and latest detection receipt time for API consumers. */
export function remoteStatus() {
  return { running: runtimeState.running, lastDetectionAt: runtimeState.latest?.receivedAt ?? null, lastError: runtimeState.lastError }
}
