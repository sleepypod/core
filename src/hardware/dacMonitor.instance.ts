/**
 * Global hardware singleton — ONE socket server, ONE client, ONE monitor.
 *
 * Lifecycle (managed by instrumentation.ts):
 *   1. startDacServer()     — listen on dac.sock, accept frankenfirmware connections
 *   2. getDacMonitor()      — create monitor + client, start polling when connected
 *   3. shutdownDacMonitor() — stop everything
 *
 * All consumers (DacMonitor, device router, health router) share the same
 * DacSocketServer and HardwareClient. No competing listeners.
 */

import { DacSocketServer } from './socketServer'
import { DacMonitor } from './dacMonitor'
import { HardwareClient } from './client'
import { GestureActionHandler } from './gestureActionHandler'
import { defaultGestureActionDeps } from './gestureActionHandler.deps'
import { DeviceStateSync } from './deviceStateSync'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'

// ── Singleton storage on globalThis (survives Turbopack module duplication) ──

const KEYS = {
  server: '__sp_dac_server__',
  client: '__sp_hw_client__',
  monitor: '__sp_dac_monitor__',
  gesture: '__sp_gesture_handler__',
} as const

const g = globalThis as Record<string, unknown>

// ── DacSocketServer (started once, before anything else) ──

export async function startDacServer(): Promise<DacSocketServer> {
  if (g[KEYS.server]) return g[KEYS.server] as DacSocketServer

  const server = new DacSocketServer()
  await server.listen(DAC_SOCK_PATH)
  g[KEYS.server] = server
  return server
}

export function getDacServer(): DacSocketServer | null {
  return (g[KEYS.server] as DacSocketServer) ?? null
}

// ── Shared HardwareClient ──

export function getSharedHardwareClient(): HardwareClient {
  if (g[KEYS.client]) return g[KEYS.client] as HardwareClient

  const server = getDacServer()
  const client = new HardwareClient({
    socketPath: DAC_SOCK_PATH,
    autoReconnect: true,
    dacServer: server ?? undefined,
  })

  g[KEYS.client] = client
  return client
}

// ── DacMonitor ──

let monitorInitPromise: Promise<DacMonitor> | null = null

export const getDacMonitor = async (): Promise<DacMonitor> => {
  if (g[KEYS.monitor]) return g[KEYS.monitor] as DacMonitor
  if (monitorInitPromise) return monitorInitPromise

  monitorInitPromise = (async () => {
    try {
      const hwClient = getSharedHardwareClient()
      const monitor = new DacMonitor({ socketPath: DAC_SOCK_PATH, hardwareClient: hwClient })
      const gestureHandler = new GestureActionHandler(DAC_SOCK_PATH, defaultGestureActionDeps)
      const stateSync = new DeviceStateSync()

      monitor.on('gesture:detected', event => gestureHandler.handle(event))
      monitor.on('status:updated', (status) => {
        stateSync.sync(status).catch(err =>
          console.error('[DacMonitor] DeviceStateSync error:', err)
        )
      })

      g[KEYS.monitor] = monitor
      g[KEYS.gesture] = gestureHandler

      await monitor.start()
      console.log('[DAC] monitor started')

      return monitor
    }
    catch (error) {
      g[KEYS.monitor] = null
      g[KEYS.gesture] = null
      throw error
    }
    finally {
      monitorInitPromise = null
    }
  })()

  return monitorInitPromise
}

export const getDacMonitorIfRunning = (): DacMonitor | null =>
  (g[KEYS.monitor] as DacMonitor) ?? null

export const shutdownDacMonitor = async (): Promise<void> => {
  if (monitorInitPromise) {
    try { await monitorInitPromise } catch { /* ok */ }
  }

  const monitor = g[KEYS.monitor] as DacMonitor | undefined
  const gestureHandler = g[KEYS.gesture] as GestureActionHandler | undefined
  const server = g[KEYS.server] as DacSocketServer | undefined

  g[KEYS.monitor] = null
  g[KEYS.gesture] = null
  g[KEYS.client] = null
  g[KEYS.server] = null
  monitorInitPromise = null

  gestureHandler?.cleanup()

  if (monitor) {
    monitor.removeAllListeners('gesture:detected')
    monitor.removeAllListeners('status:updated')
    monitor.stop()
  }

  server?.stop()

  console.log('[DAC] shutdown complete')
}
