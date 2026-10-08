import type { LucideIcon } from 'lucide-react'
import { BedDouble, Calendar, Moon, Radio, Settings, Sparkles, Thermometer } from 'lucide-react'

export type NavId = 'temp' | 'base' | 'autopilot' | 'schedule' | 'sleep' | 'system' | 'settings'

export interface NavItem {
  id: NavId
  label: string
  icon: LucideIcon
  href: string
  /** Legacy paths that should highlight this tab. */
  aliases?: string[]
}

/** User documentation (setup, features, troubleshooting). */
export const DOCS_URL = 'https://sleepypod.github.io/'

/** Base is included only when local setup exists (or in the hosted demo). */
export const NAV_ITEMS: NavItem[] = [
  { id: 'temp', label: 'Temp', icon: Thermometer, href: '/' },
  { id: 'base', label: 'Base', icon: BedDouble, href: '/base' },
  { id: 'autopilot', label: 'Autopilot', icon: Sparkles, href: '/autopilot' },
  { id: 'schedule', label: 'Schedule', icon: Calendar, href: '/schedule' },
  { id: 'sleep', label: 'Sleep', icon: Moon, href: '/sleep', aliases: ['/data'] },
  { id: 'system', label: 'System', icon: Radio, href: '/system', aliases: ['/sensors', '/debug', '/status'] },
  { id: 'settings', label: 'Settings', icon: Settings, href: '/settings' },
]

/** Strip the /[lang] prefix: /en/schedule → /schedule. */
export function pathWithoutLang(pathname: string | null | undefined): string {
  if (!pathname) return '/'
  const rest = '/' + pathname.split('/').slice(2).join('/')
  return rest === '' ? '/' : rest
}

export function langFromPath(pathname: string | null | undefined): string {
  return pathname?.split('/')[1] || 'en'
}

export function activeNavId(pathname: string | null | undefined): NavId {
  const p = pathWithoutLang(pathname)
  for (const item of NAV_ITEMS) {
    if (item.href === '/') continue
    const prefixes = [item.href, ...(item.aliases ?? [])]
    if (prefixes.some(h => p === h || p.startsWith(`${h}/`))) return item.id
  }
  return 'temp'
}
