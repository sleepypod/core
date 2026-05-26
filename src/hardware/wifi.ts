import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'

export interface WifiInfo {
  wifiStrength: number
  wifiSSID: string
}

export function getWifiInfo(): WifiInfo {
  // Pod 5 (J55) ships `iw` but not `iwgetid`, and its /proc/net/wireless
  // header has no data row — so try `iw dev … link` first; it provides
  // both signal (dBm) and SSID in one call. Fall back to the legacy
  // /proc + iwgetid pair for older pods that ship neither tool the same way.
  const fromIw = parseIwLink()
  return {
    wifiStrength: fromIw.wifiStrength ?? parseProcWirelessLink(),
    wifiSSID: fromIw.wifiSSID ?? parseIwgetidSSID(),
  }
}

function parseIwLink(): { wifiStrength: number | null, wifiSSID: string | null } {
  try {
    const iface = detectWirelessIface()
    if (!iface) return { wifiStrength: null, wifiSSID: null }
    const result = spawnSync('iw', ['dev', iface, 'link'], { encoding: 'utf-8', timeout: 2000 })
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

function detectWirelessIface(): string | null {
  try {
    const result = spawnSync('iw', ['dev'], { encoding: 'utf-8', timeout: 2000 })
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

function parseProcWirelessLink(): number {
  try {
    const raw = readFileSync('/proc/net/wireless', 'utf-8')
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

function parseIwgetidSSID(): string {
  try {
    const result = spawnSync('iwgetid', ['-r'], { encoding: 'utf-8', timeout: 2000 })
    return result.stdout?.trim() || 'unknown'
  }
  catch {
    return 'unknown'
  }
}
