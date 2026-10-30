import type { createBedroomStore } from './store'

/** Dedicated read-only topic. Broker replay never becomes current bedroom telemetry. */
export function receiveBedroomMqtt(store: ReturnType<typeof createBedroomStore>, payload: Buffer, flags: { retain: boolean, dup: boolean }): boolean {
  if (flags.retain || flags.dup || payload.length === 0 || payload.length > 4096) return false
  try {
    return store.receive(JSON.parse(payload.toString('utf8')), 'mqtt').accepted
  }
  catch { return false }
}
