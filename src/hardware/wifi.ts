import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'

export interface WifiInfo {
  wifiStrength: number
  wifiSSID: string
}

export function getWifiInfo(): WifiInfo {
  try {
    const wifiStrength = parseSignalStrength()
    const wifiSSID = parseSSID()
    return { wifiStrength, wifiSSID }
  }
  catch {
    return { wifiStrength: -1, wifiSSID: 'unknown' }
  }
}

function parseSignalStrength(): number {
  try {
    const raw = readFileSync('/proc/net/wireless', 'utf-8')
    const lines = raw.trim().split('\n')
    // Skip header lines, parse the interface line
    const dataLine = lines.find(l => l.includes(':'))
    if (!dataLine) return -1
    const parts = dataLine.trim().split(/\s+/)
    // Format: iface | status | link | level | noise ...
    const link = parseFloat(parts[2])
    if (isNaN(link)) return -1
    // link quality is 0-70 on Linux, normalize to 0-100
    return Math.round(Math.min(100, (link / 70) * 100))
  }
  catch {
    return -1
  }
}

function parseSSID(): string {
  try {
    const result = spawnSync('iwgetid', ['-r'], { encoding: 'utf-8', timeout: 2000 })
    return result.stdout?.trim() || 'unknown'
  }
  catch {
    return 'unknown'
  }
}
