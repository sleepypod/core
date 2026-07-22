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

import { POD_CAPS } from './pods'

const FIREWALL_DISPATCH = '/usr/local/bin/sp-update'

export interface IptablesStatus {
  ok: boolean
  rules: IptablesRule[]
  repaired: string[]
  /** False when inspection failed ambiguously and automatic mutation is unsafe. */
  repairable?: boolean
}

interface IptablesRule {
  name: string
  chain: 'INPUT' | 'OUTPUT'
  present: boolean
  critical: boolean
}

/** Known iptables paths from the pod capabilities manifest, used as fallbacks */
const KNOWN_IPTABLES_PATHS = [...new Set(Object.values(POD_CAPS).map(c => c.iptablesPath))]
const KNOWN_BLOCKING_TARGETS = new Set(['DROP', 'REJECT', 'SLEEPYPOD-BLOCK'])

function errorDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return ''
  const stderr = (error as Error & { stderr?: string | Buffer }).stderr
  return [error.message, stderr == null ? '' : String(stderr)].filter(Boolean).join('\n')
}

function isAbsentError(error: unknown): boolean {
  const details = error as { code?: string, status?: number } | null
  // execSync normally reports a shell lookup failure as 127. `code=ENOENT`
  // covers the direct-spawn form. Do not substring-match stderr: an installed
  // iptables can say "chain not found" or "shared object: No such file" and
  // those are degraded inspections, not proof that this is a dev host.
  return details?.code === 'ENOENT' || details?.status === 127
}

function isConfirmedMissingRule(error: unknown): boolean {
  const diagnostic = errorDiagnostic(error)
  const exitCode = (error as { status?: number } | null)?.status
  return exitCode === 1
    && /Bad rule|matching rule (?:does not|exist)|does a matching rule exist/i.test(diagnostic)
}

/** Resolve ip6tables beside the selected iptables binary, or prove it absent. */
function resolveIp6tablesPath(iptables: string): string | null {
  if (!iptables.endsWith('iptables')) return null
  const candidate = `${iptables.slice(0, -'iptables'.length)}ip6tables`
  try {
    execSync(`test -x ${candidate}`, { timeout: 2000 })
    return candidate
  }
  catch {
    return null
  }
}

/**
 * Resolve the absolute path to the iptables binary.
 * Tries `which iptables` first, then falls back to known paths from the manifest.
 */
function resolveIptablesPath(override?: string): string {
  if (override) return override

  try {
    return execSync('which iptables 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim()
  }
  catch {
    // `which` failed — try known paths
  }

  for (const candidate of KNOWN_IPTABLES_PATHS) {
    try {
      execSync(`test -x ${candidate}`, { timeout: 2000 })
      return candidate
    }
    catch {
      // not found at this path
    }
  }

  // Fall back to bare name and let execSync resolve via PATH
  return 'iptables'
}

function buildRequiredRules(iptables: string) {
  return [
    {
      name: 'mDNS outbound (UDP 5353)',
      chain: 'OUTPUT' as const,
      check: `${iptables} -C OUTPUT -p udp -d 224.0.0.251/32 --dport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'mDNS inbound (UDP 5353)',
      chain: 'INPUT' as const,
      check: `${iptables} -C INPUT -p udp -d 224.0.0.251/32 --dport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'mDNS outbound source (UDP 5353)',
      chain: 'OUTPUT' as const,
      check: `${iptables} -C OUTPUT -p udp -d 224.0.0.251/32 --sport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'LAN access (192.168.0.0/16)',
      chain: 'INPUT' as const,
      check: `${iptables} -C INPUT -s 192.168.0.0/16 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'NTP outbound (UDP 123)',
      chain: 'OUTPUT' as const,
      check: `${iptables} -C OUTPUT -p udp --dport 123 -j ACCEPT`,
      critical: true,
    },
  ]
}

/**
 * Check if all required iptables rules are present.
 * Returns status without modifying anything.
 */
export function checkIptables(iptablesPath?: string): IptablesStatus {
  const iptables = resolveIptablesPath(iptablesPath)
  const requiredRules = buildRequiredRules(iptables)
  const rules: IptablesRule[] = []
  let allOk = true
  let modeReadable = false
  let repairable = true
  let localOnly = false

  // An ACCEPT-policy OUTPUT chain without a known unconditional blocking
  // target is the deliberate "Internet Enabled" state. Explicit LAN/mDNS/NTP
  // exceptions are only required while Local Only is enforcing a DROP. `-S`
  // makes the policy and unconditional targets unambiguous and also recognizes
  // the legacy SLEEPYPOD-BLOCK jump used by older installations.
  try {
    const output = execSync(`${iptables} -S OUTPUT`, {
      encoding: 'utf-8',
      timeout: 5000,
    })
    modeReadable = true
    const policyAccept = /^-P OUTPUT ACCEPT$/m.test(output)
    const policyDrop = /^-P OUTPUT DROP$/m.test(output)
    const unconditionalTargets = [...output.matchAll(/^-A OUTPUT -j (\S+)(?:\s.*)?$/gm)]
      .map(match => match[1])
    const wanBlocked = policyDrop
      || unconditionalTargets.some(target => KNOWN_BLOCKING_TARGETS.has(target))
    localOnly = wanBlocked
    if (policyAccept && !wanBlocked) {
      return {
        ok: true,
        rules: requiredRules.map(rule => ({
          name: rule.name,
          chain: rule.chain,
          present: true,
          critical: rule.critical,
        })),
        repaired: [],
        repairable: true,
      }
    }
  }
  catch {
    // Per-rule checks below distinguish an unavailable tool from a degraded
    // ruleset, but an unreadable mode is never safe to auto-repair.
    repairable = false
  }

  // IPv6 is optional on older firmware. When the executable exists and IPv4
  // says Local Only is active, require the matching terminal IPv6 egress DROP
  // so health cannot report privacy while IPv6 WAN traffic remains open.
  if (localOnly) {
    const ip6tables = resolveIp6tablesPath(iptables)
    if (ip6tables) {
      requiredRules.push({
        name: 'IPv6 WAN block',
        chain: 'OUTPUT',
        check: `${ip6tables} -C OUTPUT -j DROP`,
        critical: true,
      })
    }
  }

  for (const rule of requiredRules) {
    let present = false
    try {
      execSync(rule.check, {
        encoding: 'utf-8',
        timeout: 5000,
      })
      present = true
    }
    catch (e) {
      const diagnostic = errorDiagnostic(e)
      if (isAbsentError(e)) {
        // No iptables executable means this is a dev/CI host, not a pod with
        // a partially applied policy. Preserve the historical fail-open check.
        present = true
      }
      else if (modeReadable && isConfirmedMissingRule(e)) {
        present = false
      }
      else {
        // Do report unknown inspection failures as degraded, but never feed
        // them into automatic repair: iptables status 1 is not uniquely a
        // missing-rule result on legacy firmware.
        present = false
        repairable = false
        console.warn(`[iptables] Failed to check ${rule.name}: ${diagnostic}`)
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

  return { ok: allOk, rules, repaired: [], repairable }
}

/**
 * Check and auto-repair missing iptables rules.
 * Returns list of rules that were repaired.
 */
export function checkAndRepairIptables(iptablesPath?: string): IptablesStatus {
  const iptables = resolveIptablesPath(iptablesPath)
  const status = checkIptables(iptables)
  if (status.ok) return status
  if (status.repairable === false) {
    console.warn('[iptables] Skipping automatic repair because firewall inspection was inconclusive')
    return status
  }

  const missing = new Set(status.rules.filter(rule => !rule.present).map(rule => rule.name))
  try {
    // Re-apply the complete, root-owned Local Only policy atomically. Direct
    // per-rule repair used to create broader UDP exceptions and could not
    // persist on Pod 5 because the unprivileged service cannot run
    // iptables-save. The helper validates, persists both IP families, and
    // rolls back the whole transition on failure.
    execSync(`sudo -n ${FIREWALL_DISPATCH} --internet-access block`, {
      encoding: 'utf-8',
      timeout: 30_000,
    })

    const verified = checkIptables(iptables)
    const repaired = verified.rules
      .filter(rule => rule.present && missing.has(rule.name))
      .map(rule => rule.name)
    if (repaired.length > 0) {
      console.log(`[iptables] Repaired Local Only policy: ${repaired.join(', ')}`)
    }
    return { ...verified, repaired }
  }
  catch (e) {
    console.error('[iptables] Failed to repair Local Only policy:', e)
    return status
  }
}
