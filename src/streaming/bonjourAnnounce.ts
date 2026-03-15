/**
 * Bonjour/mDNS service announcement for local network discovery.
 *
 * Advertises the SleepyPod service so the iOS app can find the Pod on
 * the local network without hardcoded IP addresses or manual configuration.
 *
 * Service type: _sleepypod._tcp
 * Advertised port: 3000 (tRPC HTTP API)
 * TXT records include the WebSocket port and protocol version.
 */

import Bonjour from 'bonjour-service'

let bonjour: InstanceType<typeof Bonjour> | null = null

const TRPC_PORT = Number(process.env.PORT ?? 3000)
const WS_PORT = String(process.env.PIEZO_WS_PORT ?? 3001)
const VERSION = '1.0.0'

/**
 * Publish the _sleepypod._tcp mDNS service.
 * Non-blocking — logs a warning on failure but does not crash.
 */
export function startBonjourAnnouncement(): void {
  try {
    bonjour = new Bonjour()

    bonjour.publish({
      name: 'SleepyPod',
      type: 'sleepypod',
      port: TRPC_PORT,
      txt: {
        wsPort: WS_PORT,
        version: VERSION,
      },
    })

    console.log(
      `[bonjour] Advertising _sleepypod._tcp on port ${TRPC_PORT} (wsPort=${WS_PORT})`
    )
  }
  catch (error) {
    console.warn(
      '[bonjour] Failed to start mDNS announcement:',
      error instanceof Error ? error.message : error
    )
  }
}

/**
 * Unpublish all services and tear down the mDNS responder.
 */
export function stopBonjourAnnouncement(): void {
  if (bonjour) {
    try {
      bonjour.unpublishAll()
      bonjour.destroy()
    }
    catch (error) {
      console.warn(
        '[bonjour] Error during shutdown:',
        error instanceof Error ? error.message : error
      )
    }
    bonjour = null
    console.log('[bonjour] mDNS announcement stopped')
  }
}
