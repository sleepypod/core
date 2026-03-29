/**
 * Validate and repair critical iptables rules.
 *
 * Required rules:
 * - UDP 5353 (mDNS) — needed for Bonjour discovery by iOS/web clients
 * - LAN subnet (192.168.0.0/16) — needed for API access from home network devices
 * - UDP 123 (NTP) — needed for accurate system clock
 *
 * Called on startup (instrumentation.ts) and exposed via health.system endpoint.
 */

import { execSync } from 'node:child_process'

export interface IptablesStatus {
  ok: boolean
  rules: IptablesRule[]
  repaired: string[]
}

interface IptablesRule {
  name: string
  chain: 'INPUT' | 'OUTPUT'
  present: boolean
  critical: boolean
}

const REQUIRED_RULES: Array<{
  name: string
  chain: 'INPUT' | 'OUTPUT'
  check: string // grep pattern to verify rule exists
  repair: string // iptables command to add the rule
  critical: boolean
}> = [
  {
    name: 'mDNS outbound (UDP 5353)',
    chain: 'OUTPUT',
    check: 'udp dpt:5353',
    repair: 'iptables -I OUTPUT 2 -p udp --dport 5353 -j ACCEPT',
    critical: true,
  },
  {
    name: 'mDNS inbound (UDP 5353)',
    chain: 'INPUT',
    check: 'udp dpt:5353',
    repair: 'iptables -I INPUT 2 -p udp --dport 5353 -j ACCEPT',
    critical: true,
  },
  {
    name: 'mDNS outbound source (UDP 5353)',
    chain: 'OUTPUT',
    check: 'udp spt:5353',
    repair: 'iptables -I OUTPUT 2 -p udp --sport 5353 -j ACCEPT',
    critical: true,
  },
  {
    name: 'LAN access (192.168.0.0/16)',
    chain: 'INPUT',
    check: '192.168.0.0/16',
    repair: 'iptables -A INPUT -s 192.168.0.0/16 -j ACCEPT',
    critical: true,
  },
  {
    name: 'NTP outbound (UDP 123)',
    chain: 'OUTPUT',
    check: 'udp dpt:123',
    repair: 'iptables -I OUTPUT 2 -p udp --dport 123 -j ACCEPT',
    critical: true,
  },
]

/**
 * Check if all required iptables rules are present.
 * Returns status without modifying anything.
 */
export function checkIptables(): IptablesStatus {
  const rules: IptablesRule[] = []
  let allOk = true

  for (const rule of REQUIRED_RULES) {
    let present = false
    try {
      const output = execSync(`iptables -L ${rule.chain} -n 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      })
      present = output.includes(rule.check)
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const exitCode = (e as any)?.status
      const isNotFound = msg.includes('not found') || msg.includes('ENOENT')
        || msg.includes('No such file') || exitCode === 127
      if (isNotFound) {
        // iptables binary not available (dev/CI environment) — assume ok
        present = true
      }
      else {
        // Production error (permission denied, timeout, etc.) — rule status unknown
        present = false
        console.warn(`[iptables] Failed to check ${rule.name}: ${msg}`)
      }
    }

    rules.push({
      name: rule.name,
      chain: rule.chain,
      present,
      critical: rule.critical,
    })

    if (!present && rule.critical) allOk = false
  }

  return { ok: allOk, rules, repaired: [] }
}

/**
 * Check and auto-repair missing iptables rules.
 * Returns list of rules that were repaired.
 */
export function checkAndRepairIptables(): IptablesStatus {
  const status = checkIptables()
  const repaired: string[] = []

  for (const rule of status.rules) {
    if (!rule.present) {
      const def = REQUIRED_RULES.find(r => r.name === rule.name)
      if (!def) continue

      try {
        execSync(def.repair, { encoding: 'utf-8', timeout: 5000 })
        repaired.push(rule.name)
        console.log(`[iptables] Repaired missing rule: ${rule.name}`)
      }
      catch (e) {
        console.error(`[iptables] Failed to repair rule: ${rule.name}`, e)
      }
    }
  }

  if (repaired.length > 0) {
    // Persist the repaired rules
    try {
      execSync('iptables-save > /etc/iptables/rules.v4', { encoding: 'utf-8', timeout: 5000 })
      console.log(`[iptables] Saved ${repaired.length} repaired rules to rules.v4`)
    }
    catch {
      console.warn('[iptables] Failed to persist rules — they will be lost on reboot')
    }
  }

  return { ...status, repaired }
}
