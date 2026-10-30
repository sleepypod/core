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
 * - blocking: OUTPUT drops general traffic, with the required allows present
 * - open: OUTPUT lets general traffic through (internet access allowed); the
 *   allow rules are moot, so none are reported missing
 * - missing: a listing was read and a critical allow rule is absent
 * - unknown: iptables couldn't be listed or the listing couldn't be evaluated.
 *   On a pod (permission denied, exit 3/4 when the ip_tables module isn't
 *   loaded, or an unreadable listing) this also clears `ok`; a missing binary
 *   (dev/CI) keeps `ok` true.
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

/** scripts/internet-control block keeps its allows and DROP here; OUTPUT jumps to it. */
const SLEEPYPOD_CHAIN = 'SLEEPYPOD-BLOCK'
type ListedChain = 'INPUT' | 'OUTPUT' | typeof SLEEPYPOD_CHAIN

type ListingFailure = 'absent' | 'denied' | 'failed'
/** `iptables -S <chain>` output, or why it couldn't be read. */
type Listing = { stdout: string } | { failure: ListingFailure }

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

function listingFailed(chain: ListedChain, error: unknown): Listing {
  const failure = classifyListingFailure(error)
  if (failure === 'failed') console.warn(`[iptables] Failed to check ${chain}: ${error instanceof Error ? error.message : ''}`)
  return { failure }
}

// ── `iptables -S` parsing and rule-order evaluation ─────────────────────────

export interface ParsedRule {
  target: string | null
  /** Any match beyond the target (-d, -p, -m, -o, …): the rule doesn't decide for all traffic. */
  conditional: boolean
  args: string[]
}

export interface ParsedChain {
  policy: string | null
  rules: ParsedRule[]
}

function tokenize(line: string): string[] {
  return line.match(/"(?:[^"\\]|\\.)*"|\S+/g) ?? []
}

function parseRule(args: string[]): ParsedRule {
  const rest: string[] = []
  let target: string | null = null
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-j' || args[i] === '-g') && i + 1 < args.length) {
      // -S prints matches first; what follows the target are its options
      // (--reject-with, --log-prefix), not conditions.
      target = args[i + 1] ?? null
      break
    }
    // A comment doesn't restrict which packets match.
    if (args[i] === '-m' && args[i + 1] === 'comment' && args[i + 2] === '--comment') {
      i += 3
      continue
    }
    rest.push(args[i] ?? '')
  }
  return { target, conditional: rest.length > 0, args }
}

/** Parse `iptables -S <chain>`. Null when it is empty or has a line that isn't
 * this chain's -P / -N / -A, so the caller reports the state as unknown. */
export function parseChainSpec(listing: string, chain: string): ParsedChain | null {
  const lines = listing.split('\n').map(l => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const parsed: ParsedChain = { policy: null, rules: [] }
  for (const line of lines) {
    const [op, name, ...args] = tokenize(line)
    if (name !== chain) return null
    if (op === '-P' && args.length === 1) parsed.policy = args[0] ?? null
    else if (op === '-N' && args.length === 0) continue
    else if (op === '-A') parsed.rules.push(parseRule(args))
    else return null
  }
  return parsed
}

type Verdict = 'blocking' | 'open' | 'unknown'
/** Targets that log or mark and let the packet carry on to the next rule. */
const NON_TERMINAL_TARGETS = new Set(['LOG', 'NFLOG', 'ULOG', 'MARK', 'CONNMARK', 'AUDIT', 'TRACE'])

/** Walk a chain's unconditional rules in order, as the kernel would for a
 * general outbound packet. 'continue' means it fell off the end. */
function walk(chain: ParsedChain, sleepypod: ParsedChain | null, nested: boolean): Verdict | 'continue' {
  for (const rule of chain.rules) {
    if (rule.conditional || !rule.target || NON_TERMINAL_TARGETS.has(rule.target)) continue
    if (rule.target === 'ACCEPT') return 'open'
    if (rule.target === 'DROP' || rule.target === 'REJECT') return 'blocking'
    if (rule.target === 'RETURN') return 'continue'
    if (rule.target === SLEEPYPOD_CHAIN && !nested && sleepypod) {
      const inner = walk(sleepypod, null, true)
      if (inner !== 'continue') return inner
      continue
    }
    // A jump to a chain this check doesn't read (or QUEUE etc.): can't tell.
    return 'unknown'
  }
  return 'continue'
}

/**
 * Whether a base chain blocks general traffic. Mirrors
 * wan_is_effectively_blocked / sleepypod_chain_is_effectively_blocked in
 * scripts/lib/iptables-helpers: an unconditional ACCEPT before any terminal
 * DROP/REJECT means open, a jump to SLEEPYPOD-BLOCK is followed, conditional
 * rules don't decide, and the policy decides at the end.
 */
export function chainVerdict(chain: ParsedChain, sleepypod: ParsedChain | null = null): Verdict {
  const verdict = walk(chain, sleepypod, false)
  if (verdict !== 'continue') return verdict
  if (chain.policy === 'DROP') return 'blocking'
  if (chain.policy === 'ACCEPT') return 'open'
  return 'unknown'
}

function hasPair(args: string[], [flag, value]: readonly string[]): boolean {
  return args.some((arg, i) => arg === flag && args[i + 1] === value)
}

function buildRequiredRules(iptables: string) {
  return [
    {
      name: 'mDNS outbound (UDP 5353)',
      chain: 'OUTPUT' as const,
      match: [['-p', 'udp'], ['--dport', '5353']],
      repair: `${iptables} -I OUTPUT 1 -p udp --dport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'mDNS inbound (UDP 5353)',
      chain: 'INPUT' as const,
      match: [['-p', 'udp'], ['--dport', '5353']],
      repair: `${iptables} -I INPUT 1 -p udp --dport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'mDNS outbound source (UDP 5353)',
      chain: 'OUTPUT' as const,
      match: [['-p', 'udp'], ['--sport', '5353']],
      repair: `${iptables} -I OUTPUT 1 -p udp --sport 5353 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'LAN access (192.168.0.0/16)',
      chain: 'INPUT' as const,
      match: [['-s', '192.168.0.0/16']],
      repair: `${iptables} -I INPUT 1 -s 192.168.0.0/16 -j ACCEPT`,
      critical: true,
    },
    {
      name: 'NTP outbound (UDP 123)',
      chain: 'OUTPUT' as const,
      match: [['-p', 'udp'], ['--dport', '123']],
      repair: `${iptables} -I OUTPUT 1 -p udp --dport 123 -j ACCEPT`,
      critical: true,
    },
  ]
}

function jumpsToSleepypod(listing: Listing | undefined, chain: 'INPUT' | 'OUTPUT'): boolean {
  if (!listing || !('stdout' in listing)) return false
  return !!parseChainSpec(listing.stdout, chain)?.rules.some(rule => rule.target === SLEEPYPOD_CHAIN)
}

/** Shared by checkIptables and checkIptablesCached. */
function evaluate(iptables: string, listings: Partial<Record<ListedChain, Listing>>): IptablesStatus {
  const problems = new Set<ListingFailure | 'unparseable'>()
  const parse = (chain: ListedChain): ParsedChain | null => {
    const listing = listings[chain]
    if (!listing) {
      problems.add('unparseable')
      return null
    }
    if ('failure' in listing) {
      problems.add(listing.failure)
      return null
    }
    const parsed = parseChainSpec(listing.stdout, chain)
    if (!parsed) problems.add('unparseable')
    return parsed
  }
  const sleepypodNeeded = jumpsToSleepypod(listings.INPUT, 'INPUT') || jumpsToSleepypod(listings.OUTPUT, 'OUTPUT')
  const sleepypod = sleepypodNeeded ? parse(SLEEPYPOD_CHAIN) : null
  const view = (chain: 'INPUT' | 'OUTPUT') => {
    const parsed = parse(chain)
    if (!parsed) return null
    const jumps = parsed.rules.some(rule => rule.target === SLEEPYPOD_CHAIN)
    if (jumps && !sleepypod) return null
    return {
      verdict: chainVerdict(parsed, sleepypod),
      rules: jumps && sleepypod ? [...parsed.rules, ...sleepypod.rules] : parsed.rules,
    }
  }
  const views = { INPUT: view('INPUT'), OUTPUT: view('OUTPUT') }

  // The allows only matter in front of a drop. An unread chain, or one whose
  // verdict can't be established, is unverified rather than missing: no
  // "missing" report and no repair.
  const rules = buildRequiredRules(iptables).map((rule) => {
    const chain = views[rule.chain]
    return {
      name: rule.name, chain: rule.chain, critical: rule.critical,
      present: !chain || chain.verdict !== 'blocking'
        || chain.rules.some(r => r.target === 'ACCEPT' && rule.match.every(pair => hasPair(r.args, pair))),
    }
  })

  const summary: Pick<IptablesStatus, 'ok' | 'state'> = rules.some(rule => rule.critical && !rule.present)
    ? { ok: false, state: 'missing' }
    : problems.has('denied') || problems.has('failed') || problems.has('unparseable')
      ? { ok: false, state: 'unknown' }
      : problems.has('absent') || !views.OUTPUT
        ? { ok: true, state: 'unknown' }
        : { ok: true, state: views.OUTPUT.verdict }
  return { ...summary, rules, repaired: [] }
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
    const list = async (chain: ListedChain): Promise<Listing> => {
      try {
        const { stdout } = await runFile(iptables, ['-S', chain], { timeout: 5_000 })
        return { stdout }
      }
      catch (error) {
        return listingFailed(chain, error)
      }
    }
    const [INPUT, OUTPUT] = await Promise.all([list('INPUT'), list('OUTPUT')])
    const listings: Partial<Record<ListedChain, Listing>> = { INPUT, OUTPUT }
    if (jumpsToSleepypod(INPUT, 'INPUT') || jumpsToSleepypod(OUTPUT, 'OUTPUT')) {
      listings[SLEEPYPOD_CHAIN] = await list(SLEEPYPOD_CHAIN)
    }
    const value = evaluate(iptables, listings)
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
 * Check if all required iptables rules are present.
 * Returns status without modifying anything.
 */
export function checkIptables(iptablesPath?: string): IptablesStatus {
  const iptables = resolveIptablesPath(iptablesPath)
  const list = (chain: ListedChain): Listing => {
    try {
      return { stdout: execSync(`${iptables} -S ${chain} 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }) }
    }
    catch (error) {
      return listingFailed(chain, error)
    }
  }
  const listings: Partial<Record<ListedChain, Listing>> = { INPUT: list('INPUT'), OUTPUT: list('OUTPUT') }
  if (jumpsToSleepypod(listings.INPUT, 'INPUT') || jumpsToSleepypod(listings.OUTPUT, 'OUTPUT')) {
    listings[SLEEPYPOD_CHAIN] = list(SLEEPYPOD_CHAIN)
  }
  return evaluate(iptables, listings)
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
