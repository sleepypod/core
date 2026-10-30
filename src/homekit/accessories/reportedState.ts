import type { DacMonitor } from '@/src/hardware/dacMonitor'
import type { DeviceStatus } from '@/src/hardware/types'

export const THERMOSTAT_FRESH_MS = 15_000

/** Share the post-write, timestamp-checked observation between HomeKit reads and writes. */
export function freshThermostatReport(monitor: DacMonitor): { status: DeviceStatus, observedAt: number } | null {
  try {
    const status = monitor.getFreshStatus(THERMOSTAT_FRESH_MS)
    const observedAt = monitor.getLastPollAt(), now = Date.now()
    if (!status || observedAt === null || !Number.isSafeInteger(observedAt) || observedAt <= 0
      || observedAt > now || now - observedAt >= THERMOSTAT_FRESH_MS) return null
    return { status, observedAt }
  }
  catch { return null }
}
