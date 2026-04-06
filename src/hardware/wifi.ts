import { execSync } from 'child_process'

export interface WifiInfo {
  signalStrength: number
  ssid: string
}

export function getWifiInfo(): WifiInfo {
  try {
    const signal = parseSignalStrength()
    const ssid = parseSSID()
    return { signalStrength: signal, ssid }
  }
  catch {
    return { signalStrength: -1, ssid: 'unknown' }
  }
}

function parseSignalStrength(): number {
  try {
    const raw = execSync('cat /proc/net/wireless', { encoding: 'utf-8', timeout: 2000 })
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
    return execSync('iwgetid -r', { encoding: 'utf-8', timeout: 2000 }).trim() || 'unknown'
  }
  catch {
    return 'unknown'
  }
}
