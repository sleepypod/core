/**
 * tRPC router for the archive-push feature (sp-21). Reads and writes
 * /etc/sleepypod/archive-push.conf, generates an ed25519 keypair the user
 * adds to their remote's authorized_keys, and runs a connection test via
 * `ssh -o BatchMode=yes`. The push itself is driven by a systemd timer —
 * this router only manipulates configuration.
 *
 * Why a flat KEY=VALUE conf instead of yaml: the timer's bash script
 * sources it directly, no parser needed on either side.
 */
import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'

import { publicProcedure, router } from '@/src/server/trpc'

const execFileAsync = promisify(execFile)

// Lazily read at each call so tests can override via env (vitest sets them
// in beforeAll after the module has already imported).
function paths() {
  const dir = process.env.ARCHIVE_PUSH_CONFIG_DIR ?? '/etc/sleepypod'
  const config = process.env.ARCHIVE_PUSH_CONFIG ?? path.join(dir, 'archive-push.conf')
  const identity = process.env.ARCHIVE_PUSH_IDENTITY ?? path.join(dir, 'archive-push.id_ed25519')
  return { dir, config, identity, pubkey: `${identity}.pub` }
}

// Whitelisted keys — every other key in the file is dropped on rewrite.
// (Past comments claimed passthrough; we don't actually do that.)
const KNOWN_KEYS = ['ENABLED', 'HOST', 'REMOTE_USER', 'REMOTE_PATH', 'PORT', 'IDENTITY', 'INCLUDE'] as const

// String fields land in a bash-sourced conf — reject anything that could
// terminate the line or sneak past shell-quoting (CR, LF, NUL).
const SAFE_STRING = z.string().regex(/^[^\r\n\0]*$/, 'no newlines or NUL')

const ConfigSchema = z.object({
  enabled: z.boolean(),
  host: SAFE_STRING,
  remoteUser: SAFE_STRING,
  remotePath: SAFE_STRING,
  port: z.number().int().min(1).max(65535),
  identity: SAFE_STRING,
  include: z.array(z.enum(['raw', 'db'])).min(0),
})

type ConfigShape = z.infer<typeof ConfigSchema>

function defaultConfig(): ConfigShape {
  return {
    enabled: false,
    host: '',
    remoteUser: '',
    remotePath: '',
    port: 22,
    identity: paths().identity,
    include: ['raw', 'db'],
  }
}

/**
 * Parse a KEY=VALUE conf file. Trims surrounding whitespace on both key
 * and value (manual edits often leave spaces around `=`); preserves
 * internal whitespace. The companion bash reader does the same, so the
 * file is *not* `source`d.
 */
export function parseConf(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    if (!key) continue
    out[key] = line.slice(eq + 1).trim()
  }
  return out
}

/**
 * Render a config to KEY=VALUE text. Values are written verbatim — the
 * bash reader assigns them via `declare`, never `source`, so quoting is
 * unnecessary AND attacker-controlled values cannot reach a shell parser.
 * The schema rejects CR/LF/NUL on string fields; nothing else can split a
 * line or sneak past the reader.
 */
export function renderConf(cfg: ConfigShape): string {
  const lines = [
    '# /etc/sleepypod/archive-push.conf — managed by Settings → Backup.',
    '# Read by sleepypod-archive-push as plain KEY=VALUE. Do NOT `source` it —',
    '# values are not shell-quoted on purpose.',
    `ENABLED=${cfg.enabled ? 'true' : 'false'}`,
    `HOST=${cfg.host}`,
    `REMOTE_USER=${cfg.remoteUser}`,
    `REMOTE_PATH=${cfg.remotePath}`,
    `PORT=${cfg.port}`,
    `IDENTITY=${cfg.identity}`,
    `INCLUDE=${cfg.include.join(',')}`,
    '',
  ]
  return lines.join('\n')
}

function confToShape(parsed: Record<string, string>): ConfigShape {
  const include = (parsed.INCLUDE ?? 'raw,db')
    .split(',')
    .map(s => s.trim())
    .filter((s): s is 'raw' | 'db' => s === 'raw' || s === 'db')
  const port = Number(parsed.PORT ?? '22')
  return {
    enabled: parsed.ENABLED === 'true',
    host: parsed.HOST ?? '',
    remoteUser: parsed.REMOTE_USER ?? '',
    remotePath: parsed.REMOTE_PATH ?? '',
    port: Number.isFinite(port) && port > 0 ? port : 22,
    identity: parsed.IDENTITY ?? paths().identity,
    include: include.length > 0 ? include : ['raw', 'db'],
  }
}

async function readConfig(): Promise<ConfigShape> {
  try {
    const text = await readFile(paths().config, 'utf8')
    return confToShape(parseConf(text))
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig()
    throw err
  }
}

async function writeConfig(cfg: ConfigShape): Promise<void> {
  const p = paths()
  await mkdir(p.dir, { recursive: true })
  await writeFile(p.config, renderConf(cfg), { mode: 0o640 })
}

async function readPublicKey(): Promise<string | null> {
  try {
    return (await readFile(paths().pubkey, 'utf8')).trim()
  }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export const archivePushRouter = router({
  /** Current config + whether an SSH identity has been generated. */
  getConfig: publicProcedure
    .meta({ openapi: { method: 'GET', path: '/archive-push/config', protect: false, tags: ['ArchivePush'] } })
    .input(z.object({}))
    .output(z.object({
      config: ConfigSchema,
      publicKey: z.string().nullable(),
    }))
    .query(async () => {
      const [config, publicKey] = await Promise.all([readConfig(), readPublicKey()])
      return { config, publicKey }
    }),

  /** Persist config to /etc/sleepypod/archive-push.conf. */
  setConfig: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/archive-push/config', protect: false, tags: ['ArchivePush'] } })
    .input(ConfigSchema)
    .output(z.object({ ok: z.literal(true) }))
    .mutation(async ({ input }) => {
      await writeConfig(input)
      return { ok: true }
    }),

  /**
   * Generate an ed25519 keypair at IDENTITY_PATH if it does not exist.
   * Idempotent — returns the public key either way. The user copies the
   * pubkey into their remote's authorized_keys to enable push.
   */
  generateKey: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/archive-push/key', protect: false, tags: ['ArchivePush'] } })
    .input(z.object({}))
    .output(z.object({ publicKey: z.string(), generated: z.boolean() }))
    .mutation(async () => {
      const p = paths()
      await mkdir(p.dir, { recursive: true })

      let generated = false
      try {
        await access(p.identity)
      }
      catch {
        try {
          // Quiet flag suppresses the comment line. Concurrent generateKey
          // calls will both pass access() and both invoke ssh-keygen — the
          // second hits the "Overwrite?" prompt and we'll surface the 15s
          // timeout. Acceptable: the failure mode is "user retries", and
          // the UI button is debounced by isPending anyway.
          await execFileAsync('ssh-keygen', [
            '-t', 'ed25519',
            '-N', '',
            '-q',
            '-f', p.identity,
            '-C', 'sleepypod-archive-push',
          ], { timeout: 15000 })
          generated = true
          await chmod(p.identity, 0o600).catch(() => {})
        }
        catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `ssh-keygen failed: ${err instanceof Error ? err.message : String(err)}`,
          })
        }
      }

      const pub = await readPublicKey()
      if (!pub) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Public key missing after generation',
        })
      }
      return { publicKey: pub, generated }
    }),

  /**
   * Probe the remote with `ssh -o BatchMode=yes <host> true`. Validates the
   * key is authorized + host accepts the connection. No side effects beyond
   * a possible known_hosts append on first contact.
   */
  testConnection: publicProcedure
    .meta({ openapi: { method: 'POST', path: '/archive-push/test', protect: false, tags: ['ArchivePush'] } })
    .input(z.object({}))
    .output(z.object({ ok: z.boolean(), message: z.string() }))
    .mutation(async () => {
      const cfg = await readConfig()
      if (!cfg.host || !cfg.remoteUser) {
        return { ok: false, message: 'host and remoteUser must be set before testing' }
      }
      try {
        await access(cfg.identity)
      }
      catch {
        return { ok: false, message: `identity ${cfg.identity} missing — generate a key first` }
      }
      try {
        await execFileAsync('ssh', [
          '-o', 'BatchMode=yes',
          '-o', 'StrictHostKeyChecking=accept-new',
          // sleepypod's home is /nonexistent — point known_hosts at the
          // service's writable config dir so accept-new can persist.
          '-o', `UserKnownHostsFile=${path.join(paths().dir, 'known_hosts')}`,
          '-o', 'ConnectTimeout=10',
          '-i', cfg.identity,
          '-p', String(cfg.port),
          `${cfg.remoteUser}@${cfg.host}`,
          'true',
        ], { timeout: 15000 })
        return { ok: true, message: 'connection ok' }
      }
      catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? (err instanceof Error ? err.message : String(err))
        return { ok: false, message: stderr.toString().trim().slice(0, 500) }
      }
    }),
})

// Re-export for tests that want to assert against the resolved paths.
export const __test__ = { paths, KNOWN_KEYS }
