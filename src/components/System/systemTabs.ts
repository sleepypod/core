export type SystemTab = 'dashboard' | 'calibration' | 'databases' | 'hardware' | 'health' | 'logs' | 'scheduler' | 'sensors' | 'storage' | 'thermal'

/** Dashboard is the landing page and stays first; the rest are A–Z. */
export const SYSTEM_TABS: ReadonlyArray<{ id: SystemTab, label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'databases', label: 'Databases' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'health', label: 'Health' },
  { id: 'logs', label: 'Logs' },
  { id: 'scheduler', label: 'Scheduler' },
  { id: 'sensors', label: 'Sensors' },
  { id: 'storage', label: 'Storage' },
  { id: 'thermal', label: 'Thermal' },
]

function isSystemTab(v: string | null): v is SystemTab {
  return SYSTEM_TABS.some(t => t.id === v)
}

/**
 * Resolve `?tab=` to a tab — unknown values land on the Dashboard. Legacy
 * `?tab=diagnostics&section=X` links (Diagnostics used to nest these) map to X;
 * Pipeline was folded into Health's Live stream stage.
 */
export function resolveSystemTab(raw: string | null, section: string | null = null): SystemTab {
  if (raw === 'diagnostics') return isSystemTab(section) ? section : 'dashboard'
  if (raw === 'pipeline') return 'health'
  return isSystemTab(raw) ? raw : 'dashboard'
}
