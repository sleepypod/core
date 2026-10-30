/**
 * Expose a pump stall as a fault on the affected thermostat. A LeakSensor
 * produces Apple Home water-leak alerts even though we have no leak evidence.
 */
import type { Service } from 'hap-nodejs'
import { getPumpStallNotice } from '@/src/hardware/pumpStallNotification'
import type { Side } from '@/src/hardware/types'
import { registerServiceFault } from './serviceFaults'

const POLL_MS = 5_000

/** Bind read-only fault status and return its polling cleanup. */
export function bindPumpHealth(service: Service, side: Side): () => void {
  const fault = registerServiceFault(service, () => getPumpStallNotice(side) != null)
  const handle = setInterval(fault.refresh, POLL_MS)
  handle.unref()
  return () => {
    clearInterval(handle)
    fault.stop()
  }
}
