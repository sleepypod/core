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

let started = false

export async function startHomeKitIfEnabled(): Promise<void> {
  const enabled = await readEnabled()
  if (!enabled) return
  await enable()
}

export async function enable(): Promise<void> {
  if (started) return
  const monitor = await getDacMonitor()
  await startBridge(monitor)
  started = true
}

export async function disable(): Promise<void> {
  if (!started) return
  await stopBridge()
  started = false
}

export async function shutdownHomeKit(): Promise<void> {
  await disable()
}

export function status(): BridgeStatus {
  return getStatus()
}

export async function unpair(): Promise<void> {
  await unpairAll()
  started = false
  // Re-publish if user still wants HomeKit on
  if (await readEnabled()) {
    await enable()
  }
}

export async function regeneratePairing(): Promise<BridgeStatus> {
  await regenerate()
  started = false
  if (await readEnabled()) {
    await enable()
  }
  return getStatus()
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
