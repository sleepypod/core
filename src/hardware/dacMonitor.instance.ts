/**
 * Global DacMonitor singleton.
 * Uses single-flight pattern identical to src/scheduler/instance.ts.
 */

import { DacMonitor } from './dacMonitor'
import { GestureActionHandler } from './gestureActionHandler'
import { defaultGestureActionDeps } from './gestureActionHandler.deps'
import { DeviceStateSync } from './deviceStateSync'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/run/dac.sock'

let monitorInstance: DacMonitor | null = null
let gestureHandlerInstance: GestureActionHandler | null = null
let monitorInitPromise: Promise<DacMonitor> | null = null

/**
 * Get or create the global DacMonitor instance.
 * Wires GestureActionHandler and DeviceStateSync on first call.
 *
 * The instance is registered before `start()` is awaited so that concurrent
 * callers that arrive while startup is in-flight (or after a failed start)
 * all receive the same instance rather than creating duplicates.
 */
export const getDacMonitor = async (): Promise<DacMonitor> => {
  if (monitorInstance) return monitorInstance
  if (monitorInitPromise) return monitorInitPromise

  monitorInitPromise = (async () => {
    try {
      const monitor = new DacMonitor({ socketPath: DAC_SOCK_PATH })
      const gestureHandler = new GestureActionHandler(DAC_SOCK_PATH, defaultGestureActionDeps)
      const stateSync = new DeviceStateSync()

      monitor.on('gesture:detected', event => gestureHandler.handle(event))
      monitor.on('status:updated', (status) => {
        stateSync.sync(status).catch(err =>
          console.error('[DacMonitor] DeviceStateSync error:', err)
        )
      })

      // Register as singleton BEFORE start() so concurrent callers that race
      // during initialization share the same instance.
      monitorInstance = monitor
      gestureHandlerInstance = gestureHandler

      await monitor.start()
      console.log('DacMonitor initialized')

      return monitor
    }
    catch (error) {
      // start() failed — clear the poisoned singleton so future callers can retry
      monitorInstance = null
      gestureHandlerInstance = null
      throw error
    }
    finally {
      monitorInitPromise = null
    }
  })()

  return monitorInitPromise
}

/**
 * Shutdown the global DacMonitor instance.
 * Cancels pending snooze timers, removes listeners, and stops polling.
 */
/** Non-creating accessor — returns the running instance or null without triggering lazy init. */
export const getDacMonitorIfRunning = (): DacMonitor | null => monitorInstance

export const shutdownDacMonitor = async (): Promise<void> => {
  // If initialization is in-flight, wait for it so we can shut it down cleanly
  if (monitorInitPromise) {
    try { await monitorInitPromise } catch { /* start failure is fine */ }
  }

  const monitor = monitorInstance
  const gestureHandler = gestureHandlerInstance

  // Clear instance references first so no new callers can get stale instances
  monitorInstance = null
  gestureHandlerInstance = null
  monitorInitPromise = null

  if (!monitor) return

  // Cancel any pending snooze restart timers so the process can exit cleanly
  gestureHandler?.cleanup()

  // Remove all wired event listeners before stopping
  monitor.removeAllListeners('gesture:detected')
  monitor.removeAllListeners('status:updated')

  monitor.stop()
  console.log('DacMonitor shut down')
}
