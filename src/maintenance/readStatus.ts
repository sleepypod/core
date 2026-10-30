import { DEVICE_FRESHNESS_MS } from '@/src/capabilities/contract'
import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { legacyPrivacyState } from '@/src/household/legacyPrivacy'
import { readControllerRevision } from '@/src/server/controllerRevision'
import { buildMaintenanceStatus } from './statusContract'

/** Observe the existing monitor; do not initialize hardware, schedulers or integrations. */
export async function readMaintenanceStatus() {
  const revision = await readControllerRevision()
  const monitor = getDacMonitorIfRunning()
  return buildMaintenanceStatus({
    now: Date.now(),
    revision,
    status: monitor?.getLastStatus() ?? null,
    observedAt: monitor?.getLastPollAt() ?? null,
    current: monitor?.getFreshStatus(DEVICE_FRESHNESS_MS) != null,
    privacyBoundary: legacyPrivacyState(),
  })
}
