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

import { execFile, execSync } from 'node:child_process'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

import { POD_CAPS } from './pods'

/**
 * What the firewall is doing, for display:
 * - blocking: required allow rules present in front of a drop
 * - open: OUTPUT lets everything through (internet access allowed); the allow
 *   rules are moot, so none are reported missing
 * - missing: a listing succeeded and a critical allow rule is absent
 * - unknown: iptables couldn't be listed. On a pod (permission denied, or exit
 *   3/4 when the ip_tables module isn't loaded) this also clears `ok`; a
 *   missing binary (dev/CI) keeps `ok` true.
 */
export type FirewallState = 'blocking' | 'open' | 'missing' | 'unknown'

export interface IptablesStatus {
  ok: boolean
  state: FirewallState
  rules: IptablesRule[]
  repaired: string[]
}

interface IptablesRule {
  name: string
  chain: 'INPUT' | 'OUTPUT'
  present: boolean
  critical: boolean
}

/** Known iptables paths from the pod capabilities manifest, used as fallbacks */
const KNOWN_IPTABLES_PATHS = [...new Set(Object.values(POD_CAPS).map(c => c.iptablesPath))]
const runFile = promisify(execFile)
const globalCache = globalThis as typeof globalThis & {
  __sp_iptables_health__?: {
    path: Promise<string> | null
    value: IptablesStatus | null
    expiresAt: number
    pending: Promise<IptablesStatus> | null
    generation: number
  }
}

function healthCache() {
  return globalCache.__sp_iptables_health__ ??= {
    path: null, value: null, expiresAt: 0, pending: null, generation: 0,
  }
}

type ListingFailure = 'absent' | 'denied' | 'failed'

/** absent: no iptables binary (dev/CI). denied: iptables exists but can't list
 * (no permission, or exit 3/4 — e.g. Pod 4 before ip_tables is loaded). */
function classifyListingFailure(error: unknown): ListingFailure {
  const e = (error ?? {}) as { code?: string | number, status?: number, message?: string }
  const code = e.status ?? e.code
  const message = typeof e.message === 'string' ? e.message : ''
  if (code === 'EACCES' || code === 'EPERM' || code === 3 || code === 4) return 'denied'
  if (code === 'ENOENT' || code === 127) return 'absent'
  if (/Permission denied|Operation not permitted/.test(message)) return 'denied'
  if (/not found|ENOENT|No such file/.test(message)) return 'absent'
  return 'failed'
}

function summarize(rules: IptablesRule[], outputOpen: boolean, failures: Set<ListingFailure>): Pick<IptablesStatus, 'ok' | 'state'> {
  const rulesOk = rules.every(rule => !rule.critical || rule.present)
  if (!rulesOk) return { ok: false, state: 'missing' }
  if (failures.has('denied')) return { ok: false, state: 'unknown' }
  if (failures.has('absent')) return { ok: true, state: 'unknown' }
  return { ok: true, state: outputOpen ? 'open' : 'blocking' }
}

async function resolveIptablesPathAsync(): Promise<string> {
  try {
    const { stdout } = await runFile('which', ['iptables'], { timeout: 3_000 })
    if (stdout.trim()) return stdout.trim()
  }
  catch { /* Check the Pod manifest paths when PATH omits sbin. */ }
  for (const candidate of KNOWN_IPTABLES_PATHS) {
    try {
      await access(candidate, constants.X_OK)
      return candidate
    }
    catch { /* Try the next path. */ }
  }
  return 'iptables'
}

/** Request-path diagnostics: one asynchronous listing per chain, shared across
 * concurrent requests and Next bundles, with at most 30 seconds of staleness. */
export function checkIptablesCached(): Promise<IptablesStatus> {
  const state = healthCache()
  if (state.value && performance.now() < state.expiresAt) return Promise.resolve(state.value)
  if (state.pending) return state.pending
  const generation = state.generation
  const pending = (async () => {
    const iptables = await (state.path ??= resolveIptablesPathAsync())
    const failures = new Set<ListingFailure>()
    const chains = await Promise.all((['INPUT', 'OUTPUT'] as const).map(async (chain) => {
      try {
        const { stdout } = await runFile(iptables, ['-L', chain, '-n'], { timeout: 5_000 })
        return [chain, stdout] as const
      }
      catch (error) {
        const failure = classifyListingFailure(error)
        failures.add(failure)
        if (failure === 'failed') console.warn(`[iptables] Failed to check ${chain}: ${(error as Error).message}`)
        return [chain, failure === 'failed' ? '' : null] as const
      }
    }))
    const outputs = Object.fromEntries(chains)
    // An unlisted chain is unverified, not missing: no "missing" report and no repair.
    const rules = buildRequiredRules(iptables).map(rule => ({
      name: rule.name, chain: rule.chain, critical: rule.critical,
      present: outputs[rule.chain] === null || chainAllowsAll(outputs[rule.chain] ?? '')
        || !!outputs[rule.chain]?.includes(rule.check),
    }))
    const outputOpen = typeof outputs.OUTPUT === 'string' && chainAllowsAll(outputs.OUTPUT)
    const value: IptablesStatus = { ...summarize(rules, outputOpen, failures), rules, repaired: [] }
    if (state.generation === generation) {
      state.value = value
      state.expiresAt = performance.now() + 30_000
    }
    return value
  })().finally(() => {
    if (state.pending === pending) state.pending = null
  })
  state.pending = pending
  return pending
}

export function invalidateIptablesHealth(): void {
  const state = healthCache()
  state.generation++
  state.value = null
  state.pending = null
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

/**
 * True when a `iptables -L <chain> -n` listing shows a chain that lets
 * everything through: policy ACCEPT and only ACCEPT/LOG/RETURN rules. The
 * required allow rules only matter in front of a drop, so with internet
 * access allowed (all rules flushed) they are satisfied, not missing. Any
 * other target — DROP, REJECT, or a jump to a custom chain that may drop
 * (e.g. scripts/internet-control's SLEEPYPOD-BLOCK) — falls back to the
 * exact-rule check.
 */
export function chainAllowsAll(listing: string): boolean {
  const lines = listing.split('\n')
  if (!lines.some(l => /^Chain \S+ \(policy ACCEPT/.test(l))) return false
  return lines
    .filter(l => l.trim() && !/^Chain \S+ \(policy ACCEPT[^)]*\)\s*$/.test(l)
      && !/^target\s+prot\s+opt\s+source\s+destination\s*$/.test(l))
    .every(l => /^(?:ACCEPT|LOG|RETURN)\b/.test(l))
}

function buildRequiredRules(iptables: string) {
  return [
    {
      name: 'mDNS outbound (UDP 5353)',
      chain: 'OUTPUT' as const,
      check: 'udp dpt:5353',
      repair: `${iptables} -I OUTPUT 1 -p udp --dport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'mDNS inbound (UDP 5353)',
      chain: 'INPUT' as const,
      check: 'udp dpt:5353',
      repair: `${iptables} -I INPUT 1 -p udp --dport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'mDNS outbound source (UDP 5353)',
      chain: 'OUTPUT' as const,
      check: 'udp spt:5353',
      repair: `${iptables} -I OUTPUT 1 -p udp --sport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'LAN access (192.168.0.0/16)',
      chain: 'INPUT' as const,
      check: '192.168.0.0/16',
      repair: `${iptables} -I INPUT 1 -s 192.168.0.0/16 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'NTP outbound (UDP 123)',
      chain: 'OUTPUT' as const,
      check: 'udp dpt:123',
      repair: `${iptables} -I OUTPUT 1 -p udp --dport 123 -j ACCEPT`,
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
  const failures = new Set<ListingFailure>()
  let outputOpen = false

  for (const rule of requiredRules) {
    let present = false
    try {
      const output = execSync(`${iptables} -L ${rule.chain} -n 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      })
      const open = chainAllowsAll(output)
      if (rule.chain === 'OUTPUT') outputOpen = open
      present = open || output.includes(rule.check)
    }
    catch (e) {
      const failure = classifyListingFailure(e)
      failures.add(failure)
      if (failure === 'failed') {
        // Unexpected failure on a system where iptables should work
        console.warn(`[iptables] Failed to check ${rule.name}: ${e instanceof Error ? e.message : ''}`)
      }
      else {
        // Unverified, not missing: summarize() reports it as unknown, and
        // repair isn't attempted against an iptables that can't list.
        present = true
      }
    }

    rules.push({
      name: rule.name,
      chain: rule.chain,
      present,
      critical: rule.critical,
    })
  }

  return { ...summarize(rules, outputOpen, failures), rules, repaired: [] }
}

/**
 * Check and auto-repair missing iptables rules.
 * Returns list of rules that were repaired.
 */
export function checkAndRepairIptables(iptablesPath?: string): IptablesStatus {
  invalidateIptablesHealth()
  const iptables = resolveIptablesPath(iptablesPath)
  const requiredRules = buildRequiredRules(iptables)
  const status = checkIptables(iptables)
  const repaired: string[] = []

  for (const rule of status.rules) {
    if (!rule.present) {
      const def = requiredRules.find(r => r.name === rule.name)
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
    // Persist the repaired rules — derive iptables-save path from iptables path
    const iptablesSave = iptables.replace(/iptables$/, 'iptables-save')
    try {
      execSync(`${iptablesSave} > /etc/iptables/rules.v4`, { encoding: 'utf-8', timeout: 5000 })
      console.log(`[iptables] Saved ${repaired.length} repaired rules to rules.v4`)
    }
    catch {
      console.warn('[iptables] Failed to persist rules — they will be lost on reboot')
    }
  }

  return { ...status, repaired }
}
