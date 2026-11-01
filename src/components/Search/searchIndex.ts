import type { I18n, MessageDescriptor } from '@lingui/core'
import { msg } from '@lingui/core/macro'
import type { LucideIcon } from 'lucide-react'
import {
  Activity, BookOpen, CalendarClock, Cpu, Database, HardDrive, HeartPulse, LayoutDashboard, ListChecks,
  Moon, ScrollText, SlidersHorizontal, Stethoscope, Thermometer,
} from 'lucide-react'
import { NAV_ITEMS, type NavId } from '@/src/components/AppShell/navItems'
import { AUTOPILOT_VIEWS, type AutopilotView } from '@/src/components/Autopilot/autopilotViews'
import { SECTIONS, type SectionId } from '@/src/components/Settings/sections'
import { SLEEP_SECTIONS, type SleepSection } from '@/src/components/Sleep/sleepViews'
import { SYSTEM_TABS, type SystemTab } from '@/src/components/System/systemTabs'
import { createBm25Index, tokenize } from '@/src/lib/bm25'
import { DOCS_BASE, type DocsIndex } from './docsIndex'

export interface SearchEntry {
  id: string
  title: string
  /** Parent pages, outermost first: ['Settings', 'Network']. Empty for top-level pages. */
  crumbs: string[]
  description: string
  /** Space-separated synonyms. Searched, never shown. */
  keywords: string
  /** App path without the /[lang] prefix, or an absolute URL when `external`. */
  href: string
  /** Opens `href` in a new tab instead of navigating the app. */
  external?: boolean
  icon: LucideIcon
  /** Static rank multiplier; diagnostic views sit just below settings on equal matches. */
  boost?: number
}

/**
 * Title outranks synonyms, which outrank prose. Breadcrumbs aren't indexed:
 * "Settings" on every settings entry would flatten its IDF to nothing.
 */
export const SEARCH_FIELDS = {
  title: { weight: 3, b: 0.3 },
  keywords: { weight: 1.5, b: 0.5 },
  description: { weight: 1, b: 0.75 },
} as const

const DIAGNOSTIC_BOOST = 0.75
/** Below diagnostics: an app page or setting wins an equal match against its docs page. */
const DOCS_BOOST = 0.6

const NAV_META: Record<NavId, { description: MessageDescriptor, keywords: string }> = {
  temp: { description: msg`Set each side’s temperature`, keywords: 'temperature heat cool warm thermostat home now' },
  base: { description: msg`Raise or lower the adjustable base`, keywords: 'base bed elevation head feet incline tilt position' },
  autopilot: { description: msg`Automations that adjust the bed for you`, keywords: 'automation automations rules smart' },
  schedule: { description: msg`Temperature curves, power and alarms`, keywords: 'curve curves alarm alarms wake bedtime timer program' },
  sleep: { description: msg`Nights, sleep stages and vitals`, keywords: 'nights history hypnogram stages data' },
  system: { description: msg`Pod health and diagnostics`, keywords: 'status diagnostics debug health pod' },
  settings: { description: msg`Preferences for the pod and this device`, keywords: 'preferences options configuration config' },
}

const SECTION_KEYWORDS: Record<SectionId, string> = {
  'appearance': 'theme dark light display units 3d stage dial',
  'backup': 'archive export ssh rsync nas copy nightly',
  'biometric-calibration': 'calibrate tuning accuracy heart rate breathing hrv apple watch profile',
  'device': 'pod hardware timezone power pump led maintenance reboot prime',
  'gestures': 'tap taps cover touch double triple',
  'homekit': 'apple home siri iphone',
  'mqtt': 'home assistant broker hass',
  'network': 'firewall internet wifi wi-fi online offline lan connectivity',
  'sides': 'sleepers people names away auto-off auto-on presence',
  'sleep-stages': 'stages rem deep light wake rules hypnogram',
  'updates': 'update upgrade version release software disk storage',
}

const SYSTEM_META: Record<SystemTab, { icon: LucideIcon, description: MessageDescriptor, keywords: string }> = {
  dashboard: { icon: LayoutDashboard, description: msg`Pod status at a glance`, keywords: 'status overview health issues' },
  calibration: { icon: SlidersHorizontal, description: msg`Sensor baselines for piezo, capacitance and temperature`, keywords: 'baseline piezo capacitance sensors recalibrate' },
  databases: { icon: Database, description: msg`Tables, sizes and maintenance for the pod databases`, keywords: 'sqlite db tables vacuum' },
  hardware: { icon: Cpu, description: msg`Pump, water and firmware state`, keywords: 'pump water tank firmware dac' },
  health: { icon: HeartPulse, description: msg`Service health and the live sensor pipeline`, keywords: 'pipeline services stream' },
  logs: { icon: ScrollText, description: msg`Recent service logs`, keywords: 'log journal errors events' },
  scheduler: { icon: CalendarClock, description: msg`Scheduled jobs and drift`, keywords: 'jobs cron drift timers' },
  sensors: { icon: Activity, description: msg`Raw sensor streams`, keywords: 'piezo capacitance frames stream raw' },
  storage: { icon: HardDrive, description: msg`Disk usage and recording`, keywords: 'disk space emmc recording full' },
  thermal: { icon: Thermometer, description: msg`Bed and water temperature history`, keywords: 'temperature heat water history' },
}

const SLEEP_META: Record<SleepSection, { icon: LucideIcon, description: MessageDescriptor, keywords: string }> = {
  nights: { icon: Moon, description: msg`Night-by-night sleep, stages and score`, keywords: 'night week month score hypnogram' },
  biometrics: { icon: HeartPulse, description: msg`Heart rate, HRV and breathing trends`, keywords: 'heart rate hr hrv breathing respiration vitals bpm' },
}

const AUTOPILOT_META: Record<AutopilotView, { icon: LucideIcon, description: MessageDescriptor, keywords: string }> = {
  automations: { icon: ListChecks, description: msg`Rules that change the bed for you`, keywords: 'rules automation list' },
  diagnostics: { icon: Stethoscope, description: msg`What the rules evaluated and why`, keywords: 'evaluation debug trace' },
}

/** Individual controls inside each Settings section, by their card or row heading. */
const SETTINGS: ReadonlyArray<{ section: SectionId, title: MessageDescriptor, description: MessageDescriptor, keywords: string }> = [
  { section: 'appearance', title: msg`Temperature control`, description: msg`Used on the Temp screen of this device`, keywords: 'dial slider offset level show as eight sleep' },
  { section: 'appearance', title: msg`3D stage`, description: msg`The full-screen bed on the Temp screen`, keywords: '3d bed zone readings auto-return camera heat' },
  { section: 'appearance', title: msg`Theme`, description: msg`Light or dark appearance`, keywords: 'dark light mode colour color' },
  { section: 'appearance', title: msg`Units`, description: msg`Fahrenheit or Celsius`, keywords: 'fahrenheit celsius degrees temperature unit' },

  { section: 'backup', title: msg`Nightly archive push`, description: msg`Copies the biometrics archive to a host you control over SSH, once per night`, keywords: 'backup export ssh rsync nas archive copy host' },
  { section: 'backup', title: msg`SSH identity`, description: msg`The key the pod uses to reach your host`, keywords: 'ssh key public authorized_keys identity' },

  { section: 'biometric-calibration', title: msg`Heart rate tuning`, description: msg`How heart-rate estimates are accepted and tracked`, keywords: 'hr bpm pulse heart beat profile' },
  { section: 'biometric-calibration', title: msg`Breathing tuning`, description: msg`Breathing-rate interval limits`, keywords: 'breathing respiration rr profile' },
  { section: 'biometric-calibration', title: msg`HRV index`, description: msg`When the HRV index is reported`, keywords: 'hrv heart rate variability ibi' },
  { section: 'biometric-calibration', title: msg`Import reference measurements`, description: msg`Compare the pod against Apple Watch or other references`, keywords: 'apple watch reference import health compare accuracy' },
  { section: 'biometric-calibration', title: msg`Backtests`, description: msg`Replay saved nights against a profile`, keywords: 'backtest replay evaluate dataset holdout validation' },

  { section: 'device', title: msg`Timezone`, description: msg`Where schedules and nights are anchored`, keywords: 'time zone tz location clock' },
  { section: 'device', title: msg`Temperature unit`, description: msg`Fahrenheit or Celsius across the app`, keywords: 'fahrenheit celsius degrees units' },
  { section: 'device', title: msg`Time format`, description: msg`Clocks across the app; scheduled times are unchanged`, keywords: 'clock 12h 24h am pm hour' },
  { section: 'device', title: msg`After schedule ends`, description: msg`Default power state when a curve finishes`, keywords: 'power off schedule end default curve' },
  { section: 'device', title: msg`Auto power-off cap`, description: msg`Turn sides off after a set number of hours`, keywords: 'auto off timer hours power cap shutoff' },
  { section: 'device', title: msg`Pump stall protection`, description: msg`Powers a side off when the pump stalls`, keywords: 'pump stall rpm protection water flow trip threshold dwell recovery' },
  { section: 'device', title: msg`Daily reboot`, description: msg`Restart the pod once a day`, keywords: 'restart reboot maintenance nightly' },
  { section: 'device', title: msg`Daily prime`, description: msg`Circulates water to clear air from the lines`, keywords: 'prime priming water air bubbles maintenance' },
  { section: 'device', title: msg`LED brightness`, description: msg`Brightness of the pod’s light`, keywords: 'led light brightness dim indicator' },
  { section: 'device', title: msg`LED night mode`, description: msg`Dims the LED overnight`, keywords: 'dim overnight sleep' },
  { section: 'device', title: msg`Sensor data source`, description: msg`Which firmware pipeline the pod reads`, keywords: 'firmware sensor stream frames source' },

  { section: 'gestures', title: msg`Tap gestures`, description: msg`Tap the top of the cover on your side`, keywords: 'tap double triple quad cover touch' },
  { section: 'gestures', title: msg`While an alarm is ringing`, description: msg`What a tap does to a ringing alarm`, keywords: 'alarm snooze dismiss stop tap' },

  { section: 'homekit', title: msg`HomeKit bridge`, description: msg`Adds the pod to Apple Home. Local-only — no Apple servers.`, keywords: 'apple home siri iphone pair pairing setup code' },

  { section: 'mqtt', title: msg`MQTT bridge`, description: msg`Publishes status and biometrics, accepts commands`, keywords: 'mqtt broker publish' },
  { section: 'mqtt', title: msg`Home Assistant discovery`, description: msg`Publishes climate, switch and sensor entities`, keywords: 'home assistant hass ha discovery entities' },
  { section: 'mqtt', title: msg`Broker connection`, description: msg`URL, TLS, credentials and topic prefix`, keywords: 'broker url host port tls mqtts username password topic prefix' },

  { section: 'network', title: msg`Internet access`, description: msg`Local only keeps the pod from reaching external servers`, keywords: 'firewall internet wifi wi-fi online offline local lan block iptables cloud connectivity' },

  { section: 'sides', title: msg`Bed setup`, description: msg`Choose who normally sleeps here`, keywords: 'sleepers solo couple single one person both zone' },
  { section: 'sides', title: msg`Side name`, description: msg`What each side is called`, keywords: 'name rename profile person' },
  { section: 'sides', title: msg`Away mode`, description: msg`Temporarily pause a sleeper’s tracking and alarms`, keywords: 'away vacation travel pause trip' },
  { section: 'sides', title: msg`Auto-off`, description: msg`Turns a side off after you leave the bed`, keywords: 'auto off leave bed presence empty always on' },
  { section: 'sides', title: msg`Auto-on`, description: msg`Turns a side on once you’ve settled into bed`, keywords: 'auto on presence occupancy get in bed' },

  { section: 'sleep-stages', title: msg`Stage rules`, description: msg`Each 5-minute epoch takes the first rule that matches`, keywords: 'rules epoch wake light deep rem preset' },
  { section: 'sleep-stages', title: msg`Signal limits`, description: msg`Readings outside these limits are ignored`, keywords: 'signal limits threshold low ignore' },
  { section: 'sleep-stages', title: msg`Cleanup`, description: msg`Smoothing applied after the rules`, keywords: 'smooth blips cleanup' },

  { section: 'updates', title: msg`Software`, description: msg`Installed version and updates`, keywords: 'update upgrade version release install' },
  { section: 'updates', title: msg`Update channel`, description: msg`Which releases the pod installs`, keywords: 'channel stable beta dev nightly branch' },
  { section: 'updates', title: msg`Disk`, description: msg`Storage used on the pod`, keywords: 'disk storage space emmc free full' },
]

function navLabel(id: NavId): string {
  return NAV_ITEMS.find(n => n.id === id)?.label ?? id
}

/**
 * Every page, sub-view and curated setting, translated for the active locale.
 * Base appears only when the pod has one configured.
 */
export function buildSearchEntries(i18n: I18n, { hasBase }: { hasBase: boolean }): SearchEntry[] {
  const entries: SearchEntry[] = []

  for (const item of NAV_ITEMS) {
    if (item.id === 'base' && !hasBase) continue
    entries.push({
      id: `nav:${item.id}`,
      title: item.label,
      crumbs: [],
      description: i18n._(NAV_META[item.id].description),
      keywords: NAV_META[item.id].keywords,
      href: item.href,
      icon: item.icon,
    })
  }

  const settings = navLabel('settings')
  for (const sec of SECTIONS) {
    entries.push({
      id: `settings:${sec.id}`,
      title: sec.label,
      crumbs: [settings],
      description: sec.description,
      keywords: SECTION_KEYWORDS[sec.id],
      href: `/settings?section=${sec.id}`,
      icon: sec.icon,
    })
  }

  // Settings sections have no in-page anchors yet, so a control deep-links to its section.
  SETTINGS.forEach((s, i) => {
    const sec = SECTIONS.find(x => x.id === s.section) ?? SECTIONS[0]
    entries.push({
      id: `setting:${s.section}:${i}`,
      title: i18n._(s.title),
      crumbs: [settings, sec.label],
      description: i18n._(s.description),
      keywords: s.keywords,
      href: `/settings?section=${sec.id}`,
      icon: sec.icon,
    })
  })

  const system = navLabel('system')
  for (const tab of SYSTEM_TABS) {
    const meta = SYSTEM_META[tab.id]
    entries.push({
      id: `system:${tab.id}`,
      title: tab.label,
      crumbs: [system],
      description: i18n._(meta.description),
      keywords: meta.keywords,
      href: tab.id === 'dashboard' ? '/system' : `/system?tab=${tab.id}`,
      icon: meta.icon,
      boost: tab.id === 'dashboard' ? undefined : DIAGNOSTIC_BOOST,
    })
  }

  const sleep = navLabel('sleep')
  for (const sec of SLEEP_SECTIONS) {
    const meta = SLEEP_META[sec.id]
    entries.push({
      id: `sleep:${sec.id}`,
      title: sec.label,
      crumbs: [sleep],
      description: i18n._(meta.description),
      keywords: meta.keywords,
      href: sec.id === 'nights' ? '/sleep' : `/sleep?view=${sec.id}`,
      icon: meta.icon,
    })
  }

  const autopilot = navLabel('autopilot')
  for (const view of AUTOPILOT_VIEWS) {
    const meta = AUTOPILOT_META[view.id]
    entries.push({
      id: `autopilot:${view.id}`,
      title: view.label,
      crumbs: [autopilot],
      description: i18n._(meta.description),
      keywords: meta.keywords,
      href: view.id === 'automations' ? '/autopilot' : `/autopilot?view=${view.id}`,
      icon: meta.icon,
      boost: view.id === 'diagnostics' ? DIAGNOSTIC_BOOST : undefined,
    })
  }

  return entries
}

/**
 * One entry per docs page. Headings feed the keywords rather than becoming
 * entries of their own: they outnumber app entries about 3:1 and would bury
 * them. Docs content stays English; only the 'Docs' crumb is translated.
 */
export function buildDocsEntries(i18n: I18n, index: DocsIndex): SearchEntry[] {
  const docs = i18n._(msg`Docs`)
  return index.pages.map(page => ({
    id: `docs:${page.path}`,
    title: page.title,
    crumbs: page.section ? [docs, page.section] : [docs],
    description: page.description,
    keywords: [...page.headings.map(h => h.title), page.keywords].join(' '),
    href: new URL(page.path, DOCS_BASE).href,
    external: true,
    icon: BookOpen,
    boost: DOCS_BOOST,
  }))
}

/**
 * BM25-ranked lookup over `entries`. An empty query returns nothing. Keywords
 * that repeat a title word are dropped so a synonym list can't double-count
 * the title against a shorter, exact one.
 */
export function createSearch(entries: SearchEntry[]) {
  const index = createBm25Index(
    entries.map((e) => {
      const inTitle = new Set(tokenize(e.title))
      const keywords = tokenize(e.keywords).filter(k => !inTitle.has(k)).join(' ')
      return { title: e.title, keywords, description: e.description, boost: e.boost }
    }),
    SEARCH_FIELDS,
  )
  return (query: string, limit?: number): SearchEntry[] => index.search(query, limit).map(hit => entries[hit.index])
}
