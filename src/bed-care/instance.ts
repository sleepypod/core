import { getDacMonitorIfRunning } from '@/src/hardware/dacMonitor.instance'
import { shouldBlock } from '@/src/hardware/pumpStallGuard'
import { lastBackupAt } from '@/src/lib/dbInspect'
import { getRecordingHealth } from '@/src/recording-health/instance'
import { db } from '@/src/db'
import { deviceSettings } from '@/src/db/schema'
import { evaluateBedCare, type CareSources } from './evaluate'
import { CARE_MAX_AGE_MS } from './contract'

/** Reuses the running monitor and bounded recording checks; no commands or repairs. */
export async function getBedCare() {
  const [recording, backup] = await Promise.allSettled([getRecordingHealth(), lastBackupAt()])
  const now = Date.now()
  const monitor = getDacMonitorIfRunning()
  const status = monitor?.getFreshStatus(CARE_MAX_AGE_MS)
  const at = monitor?.getLastPollAt()
  let blockedSides: CareSources['blockedSides'] = null
  try {
    blockedSides = (['left', 'right'] as const).filter(side => shouldBlock(side))
  }
  catch { /* Unknown protection state is never reported as clear. */ }
  if (!status && blockedSides?.length === 0) blockedSides = null
  let protectionEnabled: boolean | null = null
  try {
    protectionEnabled = db.select({ enabled: deviceSettings.pumpStallProtectionEnabled }).from(deviceSettings).limit(1).get()?.enabled ?? null
  }
  catch { /* Missing settings are not evidence that protection is enabled. */ }
  return evaluateBedCare({ now, blockedSides, protectionEnabled,
    hardware: status && at != null ? { at, water: status.waterLevel, priming: status.isPriming } : null,
    recording: recording.status === 'fulfilled' ? recording.value : null,
    lastExportAt: backup.status === 'fulfilled' ? backup.value : null })
}
