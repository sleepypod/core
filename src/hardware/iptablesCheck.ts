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
    const chains = await Promise.all((['INPUT', 'OUTPUT'] as const).map(async (chain) => {
      try {
        const { stdout } = await runFile(iptables, ['-L', chain, '-n'], { timeout: 5_000 })
        return [chain, stdout] as const
      }
      catch (error) {
        const e = error as Error & { code?: string | number }
        const unavailable = ['ENOENT', 'EACCES', 127, 3, 4].includes(e.code ?? '')
          || /not found|No such file|Permission denied|Operation not permitted/.test(e.message)
        if (!unavailable) console.warn(`[iptables] Failed to check ${chain}: ${e.message}`)
        return [chain, unavailable ? null : ''] as const
      }
    }))
    const outputs = Object.fromEntries(chains)
    const rules = buildRequiredRules(iptables).map(rule => ({
      name: rule.name, chain: rule.chain, critical: rule.critical,
      present: outputs[rule.chain] === null || !!outputs[rule.chain]?.includes(rule.check),
    }))
    const value = { ok: rules.every(rule => !rule.critical || rule.present), rules, repaired: [] }
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
  let allOk = true

  for (const rule of requiredRules) {
    let present = false
    try {
      const output = execSync(`${iptables} -L ${rule.chain} -n 2>/dev/null`, {
        encoding: 'utf-8',
        timeout: 5000,
      })
      present = output.includes(rule.check)
    }
    catch (e) {
      const msg = e instanceof Error ? e.message : ''
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const exitCode = (e as any)?.status
      const isUnavailable = msg.includes('not found') || msg.includes('ENOENT')
        || msg.includes('No such file') || msg.includes('Permission denied')
        || msg.includes('Operation not permitted')
        || exitCode === 127 || exitCode === 3 || exitCode === 4
      if (isUnavailable) {
        // iptables not available or not permitted (dev/CI) — assume ok
        present = true
      }
      else {
        // Unexpected failure on a system where iptables should work
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
