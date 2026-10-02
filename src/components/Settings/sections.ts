import { Cog, Download, Globe, Hand, HardDriveUpload, House, Palette, RadioTower, User, type LucideIcon } from 'lucide-react'

export const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: Palette, description: 'How this device shows the app' },
  { id: 'backup', label: 'Backup', icon: HardDriveUpload, description: 'Nightly archive to your own storage' },
  { id: 'device', label: 'Device', icon: Cog, description: 'Pod-wide hardware and maintenance' },
  { id: 'gestures', label: 'Gestures', icon: Hand, description: 'What taps on the cover do' },
  { id: 'homekit', label: 'HomeKit', icon: House, description: 'Apple Home bridge' },
  { id: 'mqtt', label: 'MQTT', icon: RadioTower, description: 'Broker connection, used by Home Assistant and other hubs' },
  { id: 'network', label: 'Network', icon: Globe, description: 'Whether the pod can reach the internet' },
  { id: 'sides', label: 'Sides', icon: User, description: 'Per-person preferences' },
  { id: 'updates', label: 'Updates', icon: Download, description: 'Software, channel and disk' },
] as const satisfies ReadonlyArray<{ id: string, label: string, icon: LucideIcon, description: string }>

export type SectionId = typeof SECTIONS[number]['id']

function isSectionId(v: string | null): v is SectionId {
  return v !== null && SECTIONS.some(s => s.id === v)
}

/**
 * Resolve the section from the URL. `?section=` wins; the legacy `?tab=`
 * values (device, sides, gestures, mqtt, backup) still deep-link.
 */
export function resolveSection(section: string | null, tab: string | null): SectionId | null {
  if (isSectionId(section)) return section
  if (isSectionId(tab)) return tab
  return null
}
