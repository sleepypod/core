/**
 * Public entry points for the embedded HomeKit bridge. Lifecycle is owned
 * by `instrumentation.ts`; the settings router calls enable/disable on toggle.
 */

import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'
import { eq } from 'drizzle-orm'
import { getDacMonitor } from '@/src/hardware/dacMonitor.instance'
import { getStatus, regenerate, startBridge, stopBridge, unpairAll } from './bridge'
import type { BridgeStatus } from './bridge'

// Turbopack splits this module across instrumentation + every API route
// chunk; per-chunk `let started` would let a tRPC call think the bridge is
// stopped while instrumentation has it running. Mirror the bridge.ts fix
// and back state with globalThis so all chunk copies see one truth.
const G = globalThis as Record<string, unknown>
const KEYS = {
  started: '__sp_homekit_started__',
  inflight: '__sp_homekit_inflight__',
} as const

const isStarted = (): boolean => Boolean(G[KEYS.started])
const setStarted = (v: boolean): void => {
  G[KEYS.started] = v
}

// Serialize lifecycle transitions so concurrent enable()/disable()/unpair()/
// regenerate() callers (settings mutation racing with status poll, retries,
// instrumentation hot-reload) cannot double-start the bridge and collide on
// port 51827. All public lifecycle entries route through `serialize`.
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const prev = (G[KEYS.inflight] as Promise<unknown> | undefined) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  G[KEYS.inflight] = next.then(() => undefined, () => undefined)
  return next
}

export async function startHomeKitIfEnabled(): Promise<void> {
  const enabled = await readEnabled()
  if (!enabled) return
  await enable()
}

export function enable(): Promise<void> {
  return serialize(async () => {
    if (isStarted()) return
    const monitor = await getDacMonitor()
    await startBridge(monitor)
    setStarted(true)
  })
}

export function disable(): Promise<void> {
  return serialize(async () => {
    if (!isStarted()) return
    await stopBridge()
    setStarted(false)
  })
}

export async function shutdownHomeKit(): Promise<void> {
  await disable()
}

export function status(): BridgeStatus {
  return getStatus()
}

export function unpair(): Promise<void> {
  return serialize(async () => {
    await unpairAll()
    setStarted(false)
    if (await readEnabled()) {
      const monitor = await getDacMonitor()
      await startBridge(monitor)
      setStarted(true)
    }
  })
}

export function regeneratePairing(): Promise<BridgeStatus> {
  return serialize(async () => {
    await regenerate()
    setStarted(false)
    if (await readEnabled()) {
      const monitor = await getDacMonitor()
      await startBridge(monitor)
      setStarted(true)
    }
    return getStatus()
  })
}

async function readEnabled(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ homekitEnabled: deviceSettings.homekitEnabled })
      .from(deviceSettings)
      .where(eq(deviceSettings.id, 1))
      .limit(1)
    return Boolean(row?.homekitEnabled)
  }
  catch (e) {
    console.warn('[homekit] failed to read enabled flag:', e instanceof Error ? e.message : e)
    return false
  }
}
