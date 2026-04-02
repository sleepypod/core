/**
 * Bonjour/mDNS service announcement for local network discovery.
 *
 * The Pod's Avahi daemon handles mDNS via a static service file at
 * /etc/avahi/services/sleepypod.service (installed by scripts/install).
 *
 * This module ensures the service file exists and Avahi is reloaded.
 * No Node.js mDNS library needed — Avahi is a proper mDNS responder
 * that correctly answers queries (the bonjour-service npm package
 * only announces but doesn't respond to lookups).
 *
 * Service type: _sleepypod._tcp
 * Advertised port: 3000 (tRPC HTTP API)
 * TXT records include the WebSocket port and protocol version.
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const TRPC_PORT = Number(process.env.PORT ?? 3000)
const WS_PORT = String(process.env.PIEZO_WS_PORT ?? 3001)
const VERSION = '1.0.0'
const SERVICE_FILE = '/etc/avahi/services/sleepypod.service'

const SERVICE_XML = `<?xml version="1.0" standalone="no"?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name>sleepypod</name>
  <service>
    <type>_sleepypod._tcp</type>
    <port>${TRPC_PORT}</port>
    <txt-record>wsPort=${WS_PORT}</txt-record>
    <txt-record>version=${VERSION}</txt-record>
  </service>
</service-group>
`

/**
 * Ensure the Avahi service file exists and reload the daemon.
 * Non-blocking — logs a warning on failure but does not crash.
 */
export function startBonjourAnnouncement(): void {
  try {
    // In dev mode (no avahi), just log and skip
    if (!existsSync('/etc/avahi')) {
      console.log('[bonjour] No Avahi found (dev mode) — skipping mDNS announcement')
      return
    }

    mkdirSync('/etc/avahi/services', { recursive: true })
    writeFileSync(SERVICE_FILE, SERVICE_XML)

    // Reload avahi to pick up the service file
    try {
      execSync('kill -HUP $(pidof avahi-daemon) 2>/dev/null', { stdio: 'ignore' })
    }
    catch {
      // avahi-daemon might not be running
    }

    console.log(
      `[bonjour] Advertising _sleepypod._tcp on port ${TRPC_PORT} (wsPort=${WS_PORT}) via Avahi`
    )
  }
  catch (error) {
    console.warn(
      '[bonjour] Failed to configure Avahi service:',
      error instanceof Error ? error.message : error
    )
  }
}

/**
 * Remove the Avahi service file and reload.
 */
export function stopBonjourAnnouncement(): void {
  try {
    if (existsSync(SERVICE_FILE)) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { unlinkSync } = require('node:fs')
      unlinkSync(SERVICE_FILE)
      try {
        execSync('kill -HUP $(pidof avahi-daemon) 2>/dev/null', { stdio: 'ignore' })
      }
      catch { /* ok */ }
    }
    console.log('[bonjour] mDNS announcement stopped')
  }
  catch (error) {
    console.warn(
      '[bonjour] Error during shutdown:',
      error instanceof Error ? error.message : error
    )
  }
}
