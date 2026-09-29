/**
 * Sensor-stream groups for System → Health's Live stream inspector, named as
 * Health names them. Color is left to status (receiving or not).
 */
export interface StreamGroup {
  key: string
  label: string
  /** Frame types (useSensorStream `type`) that belong to this group. */
  types: readonly string[]
}

export const STREAM_GROUPS: readonly StreamGroup[] = [
  { key: 'status', label: 'Device', types: ['deviceStatus'] },
  { key: 'piezo', label: 'Piezo', types: ['piezo-dual', 'lps'] },
  { key: 'presence', label: 'Presence', types: ['capSense2', 'capSense'] },
  { key: 'bedTemp', label: 'Bed temp', types: ['bedTemp2', 'bedTemp'] },
  { key: 'freezer', label: 'Freezer', types: ['frzHealth', 'frzTemp', 'frzTherm'] },
  { key: 'log', label: 'Log', types: ['log', 'gesture'] },
]

const TYPE_TO_GROUP = new Map<string, string>()
for (const g of STREAM_GROUPS) {
  for (const t of g.types) TYPE_TO_GROUP.set(t, g.key)
}

export function groupForType(type: string): string | undefined {
  return TYPE_TO_GROUP.get(type)
}

/** Compact age string for "last seen": 0.1s, 12s, 4m, 2h. */
export function fmtSeen(ageMs: number | null): string {
  if (ageMs === null) return '—'
  const s = ageMs / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}
