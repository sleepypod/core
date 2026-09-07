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
  async state(side) {
    const row = db.select().from(deviceState).where(eq(deviceState.side, side)).get()

    if (!row)
      throw new Error('Device state unavailable')

    return row
  },
  async away(side) {
    const row = db.select().from(sideSettings).where(eq(sideSettings.side, side)).get()

    if (!row)
      throw new Error('Side settings unavailable')

    return row.awayMode
  },
  async setTemperature(side, temperature) {
    return (await caller()).device.setTemperature({ side, temperature })
  },
  async setPower(side, powered) {
    return (await caller()).device.setPower({ side, powered })
  },
  async clearAlarm(side) {
    return (await caller()).device.clearAlarm({ side })
  },
  async snoozeAlarm(side, duration) {
    return (await caller()).device.snoozeAlarm({ side, duration })
  },
  async setAway(side, awayMode) {
    return (await caller()).settings.updateSide({ side, awayMode })
  },
  async prime() {
    if (shouldBlock('left') || shouldBlock('right'))
      throw new Error('Priming blocked by pump safety interlock')

    return (await caller()).device.startPriming({})
  },
  async runAutomation(id) {
    if (!db.select({ id: automations.id }).from(automations).where(eq(automations.id, id)).get())
      throw new Error('Automation no longer exists')

    await (await getAutomationEngine()).runNow(id)
  },
}
// Lazy import avoids the appRouter -> remote -> appRouter initialization cycle.
async function caller() {
  return (await import('@/src/server/routers/app')).appRouter.createCaller({})
}
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
export function startRemoteRuntime() {
  if (runtimeState.running)
    return

  // Validate persistence before enabling hardware actions.

  remoteStore.read()

  runtimeState.running = true

  runtimeState.recognizer = new RemoteRecognizer(handle)

  runtimeState.unsubscribe = onServerFrame(frame => runtimeState.recognizer?.feed(frame))
}
export async function stopRemoteRuntime() {
  runtimeState.running = false

  runtimeState.unsubscribe?.()

  runtimeState.unsubscribe = undefined

  runtimeState.recognizer?.stop()

  runtimeState.recognizer = undefined

  await runtimeState.pending

  runtimeState.listeners.clear()
}
export function subscribeRemote(listener: (event: Detection) => void) {
  runtimeState.listeners.add(listener)

  return () => {
    runtimeState.listeners.delete(listener)
  }
}
export function remoteStatus() {
  return { running: runtimeState.running, lastDetectionAt: runtimeState.latest?.receivedAt ?? null, lastError: runtimeState.lastError }
}
