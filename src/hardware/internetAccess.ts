/**
 * Internet access (WAN) control for Settings → Network, and the owner's saved
 * choice that survives reboots.
 *
 * The service runs as the sleepypod user with CAP_NET_ADMIN, so `iptables`
 * works but `iptables-save` doesn't (it reads /proc/net/ip_tables_names,
 * root 0440), and /etc/iptables is root-owned. The choice is therefore saved
 * in the data dir, next to the database. It is re-applied in two places:
 * - scripts/internet-control restore, run as root by sleepypod.service's
 *   ExecStartPre before the app starts (closes the boot window)
 * - restoreInternetAccess() at app startup (covers pods without that drop-in)
 */

import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { chainVerdict, invalidateIptablesHealth, parseChainSpec } from './iptablesCheck'

const execFileAsync = promisify(execFile)

/**
 * Resolve an executable path, checking common locations on Yocto and Debian.
 * Falls back to bare name (relies on PATH) if no candidate is found.
 */
function resolveExec(name: string, candidates: string[]): string {
  for (const p of candidates) {
    try {
      accessSync(p, constants.X_OK)
      return p
    }
    catch { /* not found, try next */ }
  }
  return name // bare name — let PATH resolve it
}

const IPTABLES = resolveExec('iptables', ['/sbin/iptables', '/usr/sbin/iptables'])

/** scripts/internet-control keeps its allows and DROP here; OUTPUT jumps to it. */
const SLEEPYPOD_CHAIN = 'SLEEPYPOD-BLOCK'

export type InternetAccessChoice = 'blocked' | 'allowed'

/** Read as root by scripts/internet-control restore; keep the name and format in sync. */
export function internetAccessChoicePath(): string {
  return path.join(path.dirname(process.env.DATABASE_URL?.replace(/^file:/, '') || './sleepypod.dev.db'), 'internet-access')
}

export async function readInternetAccessChoice(): Promise<InternetAccessChoice | null> {
  try {
    const value = (await readFile(/* turbopackIgnore: true */ internetAccessChoicePath(), 'utf8')).trim()
    return value === 'blocked' || value === 'allowed' ? value : null
  }
  catch {
    return null
  }
}

/** One word and a newline, renamed into place so the boot script never reads a partial write. */
export async function writeInternetAccessChoice(choice: InternetAccessChoice): Promise<void> {
  const file = internetAccessChoicePath()
  const temporary = `${file}.${process.pid}.tmp`
  await mkdir(/* turbopackIgnore: true */ path.dirname(file), { recursive: true })
  try {
    await writeFile(/* turbopackIgnore: true */ temporary, `${choice}\n`, { mode: 0o644 })
    await rename(/* turbopackIgnore: true */ temporary, file)
  }
  catch (error) {
    await unlink(/* turbopackIgnore: true */ temporary).catch(() => undefined)
    throw error
  }
}

const lockState = globalThis as typeof globalThis & { __sp_iptables_lock__?: Promise<void> }

/** Serialize iptables mutations across the router and startup (and Next bundles). */
export function withIptablesLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockState.__sp_iptables_lock__ ?? Promise.resolve()
  let release: (() => void) | undefined
  lockState.__sp_iptables_lock__ = new Promise<void>(r => release = r)
  return prev.then(fn).finally(() => release?.())
}

/**
 * Whether OUTPUT blocks general traffic, using the firewall check's ordered
 * evaluation: policy DROP, a terminal DROP, and the SLEEPYPOD-BLOCK chain all
 * count; an unconditional ACCEPT first means open. 'unknown' when OUTPUT
 * can't be listed or evaluated (dev box, permission denied).
 */
export async function wanVerdict(): Promise<'blocking' | 'open' | 'unknown'> {
  const list = async (chain: string) => {
    try {
      const { stdout } = await execFileAsync(IPTABLES, ['-S', chain])
      return parseChainSpec(stdout, chain)
    }
    catch {
      return null
    }
  }
  const output = await list('OUTPUT')
  if (!output) return 'unknown'
  const sleepypod = output.rules.some(rule => rule.target === SLEEPYPOD_CHAIN) ? await list(SLEEPYPOD_CHAIN) : null
  return chainVerdict(output, sleepypod)
}

export async function isWanBlocked(): Promise<boolean> {
  return (await wanVerdict()) === 'blocking'
}

/**
 * Open WAN: reset the default policies (the installer's block_wan sets them to
 * DROP, which a flush leaves in place), then flush and delete every chain in
 * the filter and nat tables. Matches unblock_wan in scripts/lib/iptables-helpers,
 * without its iptables-save snapshot, which needs root.
 */
export async function unblockWan(): Promise<void> {
  const run = (args: string[]) => execFileAsync(IPTABLES, args)
  await run(['-P', 'INPUT', 'ACCEPT'])
  await run(['-P', 'OUTPUT', 'ACCEPT'])
  await run(['-P', 'FORWARD', 'ACCEPT'])
  await run(['-F'])
  await run(['-X'])
  await run(['-t', 'nat', '-F'])
  await run(['-t', 'nat', '-X'])
}

/**
 * Re-apply LAN-only iptables rules (block WAN).
 * Mirrors the free-sleep block_internet_access.sh logic:
 *   - Allow established connections
 *   - Allow RFC 1918 LAN
 *   - Allow NTP (port 123)
 *   - Allow mDNS (port 5353)
 *   - Allow loopback
 *   - DROP everything else
 */
export async function blockWan(): Promise<void> {
  // Flush first to avoid duplicate rules
  await execFileAsync(IPTABLES, ['-F'])
  await execFileAsync(IPTABLES, ['-X'])
  await execFileAsync(IPTABLES, ['-t', 'nat', '-F'])
  await execFileAsync(IPTABLES, ['-t', 'nat', '-X'])

  const run = (args: string[]) => execFileAsync(IPTABLES, args)

  // Allow established/related
  await run(['-I', 'INPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'])
  await run(['-I', 'OUTPUT', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT'])

  // Allow RFC 1918 LAN
  for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
    await run(['-A', 'INPUT', '-s', cidr, '-j', 'ACCEPT'])
    await run(['-A', 'OUTPUT', '-d', cidr, '-j', 'ACCEPT'])
  }

  // Allow NTP
  await run(['-I', 'OUTPUT', '-p', 'udp', '--dport', '123', '-j', 'ACCEPT'])
  await run(['-I', 'INPUT', '-p', 'udp', '--sport', '123', '-j', 'ACCEPT'])

  // Allow mDNS multicast (Bonjour discovery by the apps; 224.0.0.251 is
  // outside the RFC 1918 ranges above, which already cover unicast mDNS).
  // Limited to the group so no internet host is reachable on 5353; the
  // startup check's `udp dpt:5353` / `udp spt:5353` still match these.
  await run(['-I', 'OUTPUT', '-d', '224.0.0.251', '-p', 'udp', '--dport', '5353', '-j', 'ACCEPT'])
  await run(['-I', 'INPUT', '-d', '224.0.0.251', '-p', 'udp', '--dport', '5353', '-j', 'ACCEPT'])
  await run(['-I', 'OUTPUT', '-d', '224.0.0.251', '-p', 'udp', '--sport', '5353', '-j', 'ACCEPT'])

  // Allow loopback
  await run(['-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT'])
  await run(['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT'])

  // Block everything else
  await run(['-A', 'INPUT', '-j', 'DROP'])
  await run(['-A', 'OUTPUT', '-j', 'DROP'])
}

/**
 * Apply the owner's choice and save it for the next boot. A failed save is
 * logged, not thrown: the firewall already matches what the owner asked for.
 */
export async function setInternetAccess(blocked: boolean): Promise<boolean> {
  return withIptablesLock(async () => {
    try {
      if (blocked) await blockWan()
      else await unblockWan()
    }
    finally {
      invalidateIptablesHealth()
    }
    try {
      await writeInternetAccessChoice(blocked ? 'blocked' : 'allowed')
    }
    catch (error) {
      console.error(`[internet] Couldn't save the internet access choice to ${internetAccessChoicePath()}; it won't survive a reboot:`, error instanceof Error ? error.message : error)
    }
    return isWanBlocked()
  })
}

export type InternetAccessRestore
  = | { action: 'reapplied' | 'kept' | 'inferred', choice: InternetAccessChoice }
    | { action: 'unknown' }

/**
 * Startup: make the firewall match the saved choice. "blocked" re-applies the
 * block unless OUTPUT already blocks; "allowed" never touches the rules (they
 * may be the owner's own). With no saved choice (installs from before it was
 * saved), infer it once from what the firewall does now.
 */
export async function restoreInternetAccess(): Promise<InternetAccessRestore> {
  return withIptablesLock(async () => {
    const saved = await readInternetAccessChoice()
    const verdict = await wanVerdict()
    if (!saved) {
      if (verdict === 'unknown') return { action: 'unknown' }
      const choice = verdict === 'blocking' ? 'blocked' : 'allowed'
      await writeInternetAccessChoice(choice)
      return { action: 'inferred', choice }
    }
    if (saved === 'allowed' || verdict === 'blocking') return { action: 'kept', choice: saved }
    try {
      await blockWan()
    }
    finally {
      invalidateIptablesHealth()
    }
    return { action: 'reapplied', choice: saved }
  })
}
