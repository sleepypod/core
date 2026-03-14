import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { publicProcedure, router } from '@/src/server/trpc'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const IPTABLES = '/usr/sbin/iptables'
const IPTABLES_SAVE = '/usr/sbin/iptables-save'

/**
 * Check if WAN is currently blocked by looking for a DROP rule in the OUTPUT chain.
 */
async function isWanBlocked(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(IPTABLES, ['-L', 'OUTPUT', '-n'])
    return /\bDROP\s*$/.test(stdout)
  }
  catch {
    return false
  }
}

/**
 * Flush all iptables rules (unblock WAN).
 */
async function unblockWan(): Promise<void> {
  await execFileAsync(IPTABLES, ['-F'])
  await execFileAsync(IPTABLES, ['-X'])
  await execFileAsync(IPTABLES, ['-t', 'nat', '-F'])
  await execFileAsync(IPTABLES, ['-t', 'nat', '-X'])
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
  await unblockWan()

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
  internetStatus: publicProcedure.query(async () => {
    const blocked = await isWanBlocked()
    return { blocked }
  }),

  /**
   * Toggle WAN internet access.
   * `blocked: true`  → apply LAN-only iptables rules
   * `blocked: false` → flush all iptables rules (allow everything)
   */
  setInternetAccess: publicProcedure
    .input(z.object({ blocked: z.boolean() }))
    .mutation(async ({ input }) => {
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
    }),

  /**
   * Trigger a self-update. Runs the install script in the background.
   * The service will restart as part of the install, so the response
   * may not arrive — the client should poll for reconnection.
   *
   * Optional `branch` param for testing feature branches.
   */
  triggerUpdate: publicProcedure
    .input(z.object({
      branch: z.string()
        .regex(/^[a-zA-Z0-9._\-/]+$/, 'Invalid branch name')
        .optional(),
    }).optional())
    .mutation(async ({ input }) => {
      const branch = input?.branch

      // Use sp-update for main branch (handles rollback), otherwise run install --local
      const command = branch
        ? '/bin/bash'
        : '/usr/local/bin/sp-update'

      const args = branch
        ? [
          '-c',
          `cd /home/dac/sleepypod-core && git fetch origin && git checkout "${branch}" && git reset --hard "origin/${branch}" && bash scripts/install --local --no-ssh`,
        ]
        : []

      try {
        // Fire-and-forget — the service will restart mid-update
        const { spawn } = await import('node:child_process')
        const child = spawn(command, args, {
          detached: true,
          stdio: 'ignore',
        })
        child.unref()

        return {
          triggered: true,
          branch: branch ?? 'main',
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
