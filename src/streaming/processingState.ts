/**
 * In-memory iOS processing state.
 *
 * Tracks whether an iOS client has claimed processing ownership of the
 * piezo data stream.  Imported by both the WebSocket server (to set state)
 * and the tRPC biometrics router (to read state).
 *
 * This is intentionally a simple module-level singleton — the Pod only
 * ever runs a single Node.js process, so shared memory is fine.
 */

let _iosProcessingActive = false
let _connectedSince: number | null = null

export function isIosProcessing(): boolean {
  return _iosProcessingActive
}

export function setIosProcessing(active: boolean): void {
  _iosProcessingActive = active
  _connectedSince = active ? Date.now() : null
}

export function getConnectedSince(): number | null {
  return _connectedSince
}
