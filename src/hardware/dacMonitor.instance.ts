/**
 * Read-side singleton for the DAC: owns the transport connection, the polling
 * monitor, the gesture handler, and the device-state writer. **Does not** issue
 * commands itself — every writer goes through `getSharedHardwareClient()` from
 * `./sharedClient.ts`. Keeping the write surface out of this file makes it
 * obvious what the monitor's job is (observe + broadcast) and prevents new
 * accessors from accidentally landing here.
 *
 * Lifecycle (driven by `instrumentation.ts`):
 *   1. `startDacServer()`     — kicks off the DacTransport connection on dac.sock
 *   2. `getDacMonitor()`      — creates the monitor, gesture handler, state sync;
 *                               wires status / gesture events; starts polling
 *   3. `shutdownDacMonitor()` — stops the monitor, cancels snoozes, clears the
 *                               shared client, disconnects the transport
 *
 * Backed by `globalThis` so Turbopack module duplication can't produce two
 * monitors competing for the same socket.
 */

import { connectDac, disconnectDac } from './dacTransport'
import { DacMonitor } from './dacMonitor'
import { GestureActionHandler } from './gestureActionHandler'
import { defaultGestureActionDeps } from './gestureActionHandler.deps'
import { DeviceStateSync, getAlarmState } from './deviceStateSync'
import { trackPrimingState, resetPrimingState, getPrimeCompletedAt } from './primeNotification'
import { getAllPumpStallNotices } from './pumpStallNotification'
import { cancelSnooze, getSnoozeStatus } from './snoozeManager'
import { clearSharedHardwareClient, getSharedHardwareClient } from './sharedClient'

const DAC_SOCK_PATH = process.env.DAC_SOCK_PATH || '/persistent/deviceinfo/dac.sock'

const KEYS = {
  server: '__sp_dac_server__',
  monitor: '__sp_dac_monitor__',
  gesture: '__sp_gesture_handler__',
  unsubFlow: '__sp_unsub_flow__',
} as const

const g = globalThis as Record<string, unknown>

export async function startDacServer(): Promise<void> {
  if (g[KEYS.server]) return

  // connectDac blocks until frankenfirmware connects. Run it non-blocking
  // so the app can start in degraded mode if hardware isn't available yet.
  connectDac(DAC_SOCK_PATH).catch((error) => {
    console.warn('[DAC] connection failed (will retry on next command):', error instanceof Error ? error.message : error)
  })
  g[KEYS.server] = true
}

export function getDacServer(): unknown {
  return g[KEYS.server] ?? null
}

// Re-export for callers that historically imported from this module. The
// implementation lives in `./sharedClient.ts` — new code should import there.
export { getSharedHardwareClient }

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

      monitor.on('gesture:detected', (event) => {
        gestureHandler.handle(event)
        // Broadcast to WS clients so browser UI can show gesture events
        // Dynamic import to avoid circular dependency (piezoStream is started separately)
        import('../streaming/piezoStream').then(({ broadcastFrame }) => {
          broadcastFrame({
            type: 'gesture',
            ts: Date.now(),
            side: event.side,
            tapType: event.tapType,
          })
        }).catch(() => { /* WS not ready */ })
      })
      monitor.on('status:updated', (status) => {
        try {
          trackPrimingState(status.isPriming)
        }
        catch (err) {
          console.error('[DacMonitor] primeNotification error:', err)
        }
        stateSync.sync(status).catch(err =>
          console.error('[DacMonitor] DeviceStateSync error:', err)
        )

        // Broadcast device status to WebSocket clients
        // Dynamic import to avoid circular dependency (piezoStream is started separately)
        import('../streaming/piezoStream').then(({ broadcastFrame }) => {
          const primeCompletedAt = getPrimeCompletedAt()
          const alarmState = getAlarmState()
          const stallNotices = getAllPumpStallNotices()
          broadcastFrame({
            type: 'deviceStatus',
            ts: Date.now(),
            leftSide: { ...status.leftSide, isAlarmVibrating: alarmState.left },
            rightSide: { ...status.rightSide, isAlarmVibrating: alarmState.right },
            waterLevel: status.waterLevel,
            isPriming: status.isPriming,
            ...(primeCompletedAt && { primeCompletedNotification: { timestamp: primeCompletedAt } }),
            ...((stallNotices.left || stallNotices.right) && { pumpStallNotifications: stallNotices }),
            snooze: {
              left: getSnoozeStatus('left'),
              right: getSnoozeStatus('right'),
            },
          })
        }).catch(() => { /* WS server may not be started yet */ })
      })

      // Subscribe to frzHealth frames from the sensor stream to record flow data
      import('../streaming/piezoStream').then(({ onServerFrame }) => {
        g[KEYS.unsubFlow] = onServerFrame((frame) => {
          stateSync.recordFlowData(frame as Record<string, unknown>)
        })
      }).catch(() => { /* WS server may not be started yet */ })

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
    try {
      await monitorInitPromise
    }
    catch { /* ok */ }
  }

  const monitor = g[KEYS.monitor] as DacMonitor | undefined
  const gestureHandler = g[KEYS.gesture] as GestureActionHandler | undefined

  cancelSnooze('left')
  cancelSnooze('right')
  resetPrimingState()

  const unsubFlow = g[KEYS.unsubFlow] as (() => void) | undefined
  unsubFlow?.()

  g[KEYS.monitor] = null
  g[KEYS.gesture] = null
  g[KEYS.server] = null
  g[KEYS.unsubFlow] = null
  clearSharedHardwareClient()
  monitorInitPromise = null

  gestureHandler?.cleanup()

  if (monitor) {
    monitor.removeAllListeners('gesture:detected')
    monitor.removeAllListeners('status:updated')
    monitor.stop()
  }

  await disconnectDac()

  console.log('[DAC] shutdown complete')
}
