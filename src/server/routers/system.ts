import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IPTABLES = '/usr/sbin/iptables'
const IPTABLES_SAVE = '/usr/sbin/iptables-save'

/**
 * Simple async mutex to serialize iptables mutations.
 */
let iptablesLock: Promise<void> = Promise.resolve()
function withIptablesLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = iptablesLock
  let release: (() => void) | undefined
  iptablesLock = new Promise<void>(r => release = r)
  return prev.then(fn).finally(() => release?.())
}

/**
 * Check if WAN is currently blocked by looking for a DROP rule in the OUTPUT chain.
 */
async function isWanBlocked(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(IPTABLES, ['-L', 'OUTPUT', '-n'])
    return /\bDROP\s*$/m.test(stdout)
  }
  catch {
    return false
  }
}

/**
 * Save current iptables rules, flush to unblock WAN, return saved rules for restore.
 */
async function unblockWan(): Promise<string> {
  const { stdout: saved } = await execFileAsync(IPTABLES_SAVE)
  await execFileAsync(IPTABLES, ['-F'])
  await execFileAsync(IPTABLES, ['-X'])
  await execFileAsync(IPTABLES, ['-t', 'nat', '-F'])
  await execFileAsync(IPTABLES, ['-t', 'nat', '-X'])
  return saved
}

/**
 * Re-apply LAN-only iptables rules (block WAN).
 * Mirrors the free-sleep block_internet_access.sh logic:
 *   - Allow established connections
 *   - Allow RFC 1918 LAN
 *   - Allow NTP (port 123)
 *   - Allow loopback
 *   - DROP everything else
 */
async function blockWan(): Promise<void> {
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

  // Allow loopback
  await run(['-A', 'INPUT', '-i', 'lo', '-j', 'ACCEPT'])
  await run(['-A', 'OUTPUT', '-o', 'lo', '-j', 'ACCEPT'])

  // Block everything else
  await run(['-A', 'INPUT', '-j', 'DROP'])
  await run(['-A', 'OUTPUT', '-j', 'DROP'])

  // Persist rules
  try {
    const { stdout } = await execFileAsync(IPTABLES_SAVE)
    const { writeFile, mkdir } = await import('node:fs/promises')
    await mkdir('/etc/iptables', { recursive: true })
    await writeFile('/etc/iptables/iptables.rules', stdout)
  }
  catch {
    // Best-effort persist — non-fatal
  }
}

/**
 * System router — iptables control and self-update triggers.
 *
 * Procedures:
 * - `internetStatus`     — check if WAN is blocked
 * - `setInternetAccess`  — toggle WAN block on/off
 * - `triggerUpdate`       — kick off sp-update (or a deploy-driven install)
 */
export const systemRouter = router({
  /**
   * Returns whether WAN access is currently blocked by iptables.
   */
  internetStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/internet-status', protect: false, tags: ['System'] } })
    .input(z.object({}))
    .output(z.object({ blocked: z.boolean() }))
    .query(async () => {
      const blocked = await isWanBlocked()
      return { blocked }
    }),

  /**
   * Toggle WAN internet access.
   * `blocked: true`  → apply LAN-only iptables rules
   * `blocked: false` → flush all iptables rules (allow everything)
   */
  setInternetAccess: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/system/internet-access', protect: false, tags: ['System'] } })
    .input(z.object({ blocked: z.boolean() }))
    .output(z.object({ blocked: z.boolean() }))
    .mutation(async ({ input }) => {
      return withIptablesLock(async () => {
        try {
          if (input.blocked) {
            await blockWan()
          }
          else {
            await unblockWan()
          }
          const currentState = await isWanBlocked()
          return { blocked: currentState }
        }
        catch (error) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Failed to update iptables: ${error instanceof Error ? error.message : 'Unknown error'}`,
            cause: error,
          })
        }
      })
    }),

  /**
   * Returns WiFi connection status and signal strength.
   * Uses nmcli on Linux; returns a graceful fallback in dev environments.
   */
  wifiStatus: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/system/wifi-status', protect: false, tags: ['System'] } })
    .input(z.object({}))
    .output(z.object({
      connected: z.boolean(),
      ssid: z.string().nullable(),
      signal: z.number().nullable(),
    }))
    .query(async () => {
      try {
        const { stdout } = await execFileAsync('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'])
        const active = stdout.trim().split('\n').find(l => l.startsWith('yes:'))
        if (!active) return { connected: false, ssid: null, signal: null }

        // nmcli -t escapes colons as \: and backslashes as \\
        const fields: string[] = []
        let current = ''
        for (let i = 0; i < active.length; i++) {
          if (active[i] === '\\' && i + 1 < active.length) {
            current += active[++i]
          }
          else if (active[i] === ':') {
            fields.push(current)
            current = ''
          }
          else {
            current += active[i]
          }
        }
        fields.push(current)

        return {
          connected: true,
          ssid: fields[1] || null,
          signal: fields[2] ? Number(fields[2]) : null,
        }
      }
      catch {
        // nmcli unavailable (dev environment, macOS, etc.)
        return { connected: false, ssid: null, signal: null }
      }
    }),

  /**
   * Trigger a self-update via curl+tarball from GitHub.
   *
   * sp-update handles the full flow: iptables toggle, tarball download,
   * dependency install, build, and service restart. The response may not
   * arrive since the service restarts — client should poll for reconnection.
   *
   * Optional `branch` param for deploying feature branches.
   */
  triggerUpdate: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/system/update', protect: false, tags: ['System'] } })
    .input(z.object({
      branch: z.string()
        .regex(/^[a-zA-Z0-9._\-/]+$/, 'Invalid branch name')
        .optional(),
    }))
    .output(z.object({
      triggered: z.boolean(),
      branch: z.string(),
      message: z.string(),
    }))
    .mutation(async ({ input }) => {
      const branch = input?.branch ?? 'main'

      try {
        const { spawn } = await import('node:child_process')

        const child = spawn('/usr/local/bin/sp-update', [branch], {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()

        return {
          triggered: true,
          branch,
          message: 'Update started. Service will restart — poll for reconnection.',
        }
      }
      catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Failed to trigger update: ${error instanceof Error ? error.message : 'Unknown error'}`,
          cause: error,
        })
      }
    }),
})
