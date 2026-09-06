import { readFile } from 'fs/promises'
import { execFile } from 'child_process'
import { promisify } from 'util'

export interface WifiInfo {
  wifiStrength: number
  wifiSSID: string
}

// systemd unit pins PATH to /usr/local/bin:/usr/bin:/bin, but `iw` lives in
// /usr/sbin on Pod 5. Broaden lookup paths for any spawned wifi binary so
// the process resolves regardless of how the unit's PATH is configured.
const SPAWN_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const execFileAsync = promisify(execFile)
const SPAWN_OPTS = { encoding: 'utf-8' as const, timeout: 2000, killSignal: 'SIGKILL' as const, env: { ...process.env, PATH: SPAWN_PATH } }

const CACHE_MS = 30_000
interface WifiCache {
  value: WifiInfo
  updatedAt: number | null
  pending: Promise<void> | null
}
const g = globalThis as Record<string, unknown>
const CACHE_KEY = '__sp_wifi_info__'

/** Return immediately; at most one asynchronous refresh runs every 30 seconds. */
export function getWifiInfo(): WifiInfo {
  const cache = (g[CACHE_KEY] ??= {
    value: { wifiStrength: -1, wifiSSID: 'unknown' }, updatedAt: null, pending: null,
  }) as WifiCache
  const age = cache.updatedAt === null ? Infinity : Date.now() - cache.updatedAt
  if (!cache.pending && (age < 0 || age >= CACHE_MS)) {
    cache.pending = readWifiInfo().then((value) => {
      cache.value = value
    }).finally(() => {
      cache.updatedAt = Date.now()
      cache.pending = null
    })
  }
  return { ...cache.value }
}

/** Probe the current Wi-Fi state without blocking the Node event loop. */
export async function readWifiInfo(): Promise<WifiInfo> {
  // Pod 5 (J55) ships `iw` but not `iwgetid`, and its /proc/net/wireless
  // header has no data row — so try `iw dev … link` first; it provides
  // both signal (dBm) and SSID in one call. Fall back to the legacy
  // /proc + iwgetid pair for older pods that ship neither tool the same way.
  const fromIw = await parseIwLink()
  return {
    wifiStrength: fromIw.wifiStrength ?? await parseProcWirelessLink(),
    wifiSSID: fromIw.wifiSSID ?? await parseIwgetidSSID(),
  }
}

async function parseIwLink(): Promise<{ wifiStrength: number | null, wifiSSID: string | null }> {
  try {
    const iface = await detectWirelessIface()
    if (!iface) return { wifiStrength: null, wifiSSID: null }
    const result = await execFileAsync('iw', ['dev', iface, 'link'], SPAWN_OPTS)
    const out = result.stdout?.trim()
    if (!out || out.startsWith('Not connected')) return { wifiStrength: null, wifiSSID: null }

    let wifiStrength: number | null = null
    let wifiSSID: string | null = null
    for (const line of out.split('\n')) {
      const s = line.trim()
      const sigMatch = s.match(/^signal:\s*(-?\d+)\s*dBm/)
      if (sigMatch) wifiStrength = dbmToPercent(parseInt(sigMatch[1], 10))
      const ssidMatch = s.match(/^SSID:\s*(.+)$/)
      if (ssidMatch) wifiSSID = ssidMatch[1].trim()
    }
    return { wifiStrength, wifiSSID }
  }
  catch {
    return { wifiStrength: null, wifiSSID: null }
  }
}

async function detectWirelessIface(): Promise<string | null> {
  try {
    const result = await execFileAsync('iw', ['dev'], SPAWN_OPTS)
    const match = result.stdout?.match(/Interface\s+(\S+)/)
    return match ? match[1] : null
  }
  catch {
    return null
  }
}

// dBm → 0-100. -50 dBm or stronger = 100, -100 dBm = 0, linear between.
function dbmToPercent(dbm: number): number {
  return Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))))
}

async function parseProcWirelessLink(): Promise<number> {
  try {
    const raw = await readFile('/proc/net/wireless', 'utf-8')
    const lines = raw.trim().split('\n')
    const dataLine = lines.find(l => l.includes(':'))
    if (!dataLine) return -1
    const parts = dataLine.trim().split(/\s+/)
    const link = parseFloat(parts[2])
    if (isNaN(link)) return -1
    return Math.round(Math.min(100, (link / 70) * 100))
  }
  catch {
    return -1
  }
}

async function parseIwgetidSSID(): Promise<string> {
  try {
    const result = await execFileAsync('iwgetid', ['-r'], SPAWN_OPTS)
    return result.stdout?.trim() || 'unknown'
  }
  catch {
    return 'unknown'
  }
}
