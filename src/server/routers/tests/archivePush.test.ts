/**
 * Unit tests for the archive-push router. Covers conf parsing/rendering,
 * getConfig/setConfig roundtrip on a temp dir, and behaviour when the conf
 * is absent. ssh-keygen / ssh are mocked via vi.mock('node:child_process')
 * so generateKey + testConnection happy/error branches are exercised
 * without invoking real binaries.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Hoisted control surface for the execFile mock. Each test sets `impl` to
// the (cmd, args) -> { stdout, stderr } | throw it wants.
const execMock = vi.hoisted(() => {
  type Impl = (cmd: string, args: readonly string[]) => { stdout?: string, stderr?: string } | Promise<{ stdout?: string, stderr?: string }>
  const state: { impl: Impl } = { impl: () => ({ stdout: '', stderr: '' }) }
  return state
})

vi.mock('node:child_process', () => {
  // Callback-style execFile so promisify wraps it correctly. The router
  // ignores stdout/stderr — only the resolve/reject matters here.
  function execFile(
    cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
  ): void {
    Promise.resolve()
      .then(() => execMock.impl(cmd, args))
      .then(
        out => cb(null, out?.stdout ?? '', out?.stderr ?? ''),
        (err: Error & { stderr?: string }) => {
          // Match Node's execFile error shape (carries .stderr) so the router's
          // `(err as { stderr?: string }).stderr` branch is exercised.
          cb(err as NodeJS.ErrnoException, '', err?.stderr ?? '')
        },
      )
  }
  return {
    execFile,
    default: { execFile },
  }
})

let configDir: string

beforeAll(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'sp-push-test-'))
  process.env.ARCHIVE_PUSH_CONFIG_DIR = configDir
  process.env.ARCHIVE_PUSH_CONFIG = path.join(configDir, 'archive-push.conf')
  process.env.ARCHIVE_PUSH_IDENTITY = path.join(configDir, 'archive-push.id_ed25519')
})

afterAll(async () => {
  await rm(configDir, { recursive: true, force: true })
  delete process.env.ARCHIVE_PUSH_CONFIG_DIR
  delete process.env.ARCHIVE_PUSH_CONFIG
  delete process.env.ARCHIVE_PUSH_IDENTITY
})

beforeEach(async () => {
  await rm(path.join(configDir, 'archive-push.conf'), { force: true })
  await rm(path.join(configDir, 'archive-push.id_ed25519'), { force: true })
  await rm(path.join(configDir, 'archive-push.id_ed25519.pub'), { force: true })
  // Reset execFile behaviour to a benign success — tests opt into failures.
  execMock.impl = () => ({ stdout: '', stderr: '' })
})

const { archivePushRouter, parseConf, renderConf } = await import('@/src/server/routers/archivePush')
const caller = archivePushRouter.createCaller({})

describe('parseConf', () => {
  it('parses KEY=VALUE pairs and ignores blanks + comments', () => {
    const result = parseConf([
      '# leading comment',
      '',
      'ENABLED=true',
      '  HOST=nas.local  ',
      '# inline comment line',
      'PORT=2222',
    ].join('\n'))
    expect(result).toEqual({ ENABLED: 'true', HOST: 'nas.local', PORT: '2222' })
  })

  it('preserves values verbatim — does not strip quotes (we do not source)', () => {
    const result = parseConf('REMOTE_PATH="/volume1/sleepypod"\nINCLUDE=\'raw,db\'')
    expect(result.REMOTE_PATH).toBe('"/volume1/sleepypod"')
    expect(result.INCLUDE).toBe('\'raw,db\'')
  })

  it('skips lines without =', () => {
    const result = parseConf('ENABLED=true\nbogus line\nHOST=h')
    expect(result).toEqual({ ENABLED: 'true', HOST: 'h' })
  })

  it('drops blank keys (line starting with =)', () => {
    const result = parseConf('=novalue\nHOST=h')
    expect(result).toEqual({ HOST: 'h' })
  })
})

describe('renderConf', () => {
  it('round-trips with parseConf', () => {
    const cfg = {
      enabled: true,
      host: 'nas.local',
      remoteUser: 'sleepypod',
      remotePath: '/volume1/archive',
      port: 2222,
      identity: '/etc/sleepypod/key',
      include: ['raw', 'db'] as const,
    }
    const rendered = renderConf({ ...cfg, include: [...cfg.include] })
    const parsed = parseConf(rendered)
    expect(parsed.ENABLED).toBe('true')
    expect(parsed.HOST).toBe('nas.local')
    expect(parsed.REMOTE_USER).toBe('sleepypod')
    expect(parsed.REMOTE_PATH).toBe('/volume1/archive')
    expect(parsed.PORT).toBe('2222')
    expect(parsed.IDENTITY).toBe('/etc/sleepypod/key')
    expect(parsed.INCLUDE).toBe('raw,db')
  })

  // Regression: the original renderer interpolated values raw and the bash
  // script `source`d the result, so a malicious LAN client could land RCE
  // via `host: "x$(curl … | bash)"`. We now read KEY=VALUE without sourcing,
  // and the schema rejects CR/LF/NUL — so every other byte must round-trip.
  it('round-trips values containing shell metacharacters', () => {
    const cfg = {
      enabled: false,
      host: 'host with space and $(cmd)',
      remoteUser: 'user`tick`',
      remotePath: '/path with \'quote\' and "dquote"',
      port: 22,
      identity: '/etc/sleepypod/key',
      include: ['raw'] as const,
    }
    const parsed = parseConf(renderConf({ ...cfg, include: [...cfg.include] }))
    expect(parsed.HOST).toBe(cfg.host)
    expect(parsed.REMOTE_USER).toBe(cfg.remoteUser)
    expect(parsed.REMOTE_PATH).toBe(cfg.remotePath)
    expect(parsed.IDENTITY).toBe(cfg.identity)
  })
})

describe('archivePush.getConfig', () => {
  it('returns defaults when no conf exists', async () => {
    const result = await caller.getConfig({})
    expect(result.config.enabled).toBe(false)
    expect(result.config.host).toBe('')
    expect(result.config.port).toBe(22)
    expect(result.config.include).toEqual(['raw', 'db'])
    expect(result.publicKey).toBeNull()
  })

  it('reads an existing conf file', async () => {
    await writeFile(
      path.join(configDir, 'archive-push.conf'),
      [
        'ENABLED=true',
        'HOST=nas.local',
        'REMOTE_USER=backup',
        'REMOTE_PATH=/volume1/sp',
        'PORT=2222',
        'INCLUDE=raw',
      ].join('\n'),
    )
    const result = await caller.getConfig({})
    expect(result.config.enabled).toBe(true)
    expect(result.config.host).toBe('nas.local')
    expect(result.config.remoteUser).toBe('backup')
    expect(result.config.port).toBe(2222)
    expect(result.config.include).toEqual(['raw'])
  })

  it('surfaces public key when present', async () => {
    await writeFile(path.join(configDir, 'archive-push.id_ed25519.pub'), 'ssh-ed25519 AAAA test\n')
    const result = await caller.getConfig({})
    expect(result.publicKey).toBe('ssh-ed25519 AAAA test')
  })

  it('falls back to defaults when PORT is non-numeric', async () => {
    await writeFile(
      path.join(configDir, 'archive-push.conf'),
      'PORT=notanumber\nINCLUDE=',
    )
    const result = await caller.getConfig({})
    // Number('notanumber') -> NaN -> guarded fallback to 22
    expect(result.config.port).toBe(22)
    // INCLUDE= with empty value -> fall back to default ['raw','db']
    expect(result.config.include).toEqual(['raw', 'db'])
  })

  it('propagates non-ENOENT errors from readFile', async () => {
    // Replace the conf path with a directory — readFile then rejects EISDIR
    // which the router rethrows (only ENOENT is swallowed).
    await mkdir(path.join(configDir, 'archive-push.conf'), { recursive: true })
    await expect(caller.getConfig({})).rejects.toThrow()
    await rm(path.join(configDir, 'archive-push.conf'), { recursive: true, force: true })
  })

  it('propagates non-ENOENT errors from readPublicKey', async () => {
    await mkdir(path.join(configDir, 'archive-push.id_ed25519.pub'), { recursive: true })
    await expect(caller.getConfig({})).rejects.toThrow()
    await rm(path.join(configDir, 'archive-push.id_ed25519.pub'), { recursive: true, force: true })
  })
})

describe('archivePush.setConfig', () => {
  it('persists values readable by getConfig', async () => {
    await caller.setConfig({
      enabled: true,
      host: 'nas.local',
      remoteUser: 'sp',
      remotePath: '/volume1/sp',
      port: 22,
      identity: path.join(configDir, 'archive-push.id_ed25519'),
      include: ['raw'],
    })

    const text = await readFile(path.join(configDir, 'archive-push.conf'), 'utf8')
    expect(text).toMatch(/ENABLED=true/)
    expect(text).toMatch(/HOST=nas\.local/)
    expect(text).toMatch(/INCLUDE=raw/)

    const reread = await caller.getConfig({})
    expect(reread.config.enabled).toBe(true)
    expect(reread.config.host).toBe('nas.local')
    expect(reread.config.include).toEqual(['raw'])
  })
})

describe('archivePush.generateKey', () => {
  it('shells out to ssh-keygen, writes pubkey, returns generated=true', async () => {
    const pubPath = path.join(configDir, 'archive-push.id_ed25519.pub')
    execMock.impl = async (cmd, args) => {
      expect(cmd).toBe('ssh-keygen')
      // Identity path is passed via -f
      const idIdx = args.indexOf('-f')
      expect(idIdx).toBeGreaterThan(-1)
      const identity = args[idIdx + 1]
      // Real ssh-keygen would write both the private + .pub — fake only the
      // .pub here (chmod on the missing private file is .catch()'d).
      await writeFile(pubPath, 'ssh-ed25519 AAAAfaked sleepypod-archive-push\n')
      // Also create the private file so the post-keygen chmod doesn't ENOENT
      await writeFile(identity, 'PRIVATE')
      return { stdout: '', stderr: '' }
    }

    const result = await caller.generateKey({})
    expect(result.generated).toBe(true)
    expect(result.publicKey).toContain('ssh-ed25519')
  })

  it('returns generated=false when identity already exists', async () => {
    const identity = path.join(configDir, 'archive-push.id_ed25519')
    const pubPath = `${identity}.pub`
    await writeFile(identity, 'PRIVATE')
    await writeFile(pubPath, 'ssh-ed25519 AAAApreexisting sleepypod\n')

    let calls = 0
    execMock.impl = () => {
      calls += 1
      return { stdout: '', stderr: '' }
    }

    const result = await caller.generateKey({})
    expect(result.generated).toBe(false)
    expect(result.publicKey).toContain('AAAApreexisting')
    expect(calls).toBe(0) // ssh-keygen was NOT invoked
  })

  it('throws INTERNAL_SERVER_ERROR when ssh-keygen fails', async () => {
    execMock.impl = () => {
      throw new Error('keygen boom')
    }
    await expect(caller.generateKey({})).rejects.toThrow(/ssh-keygen failed: keygen boom/)
  })

  it('throws when ssh-keygen succeeded but no pubkey landed on disk', async () => {
    // Pretend ssh-keygen ran fine but produced nothing — guards against a
    // silent partial-success leaving the user with no key to copy.
    const identity = path.join(configDir, 'archive-push.id_ed25519')
    execMock.impl = async () => {
      await writeFile(identity, 'PRIVATE')
      // Deliberately do NOT write the .pub
      return { stdout: '', stderr: '' }
    }
    await expect(caller.generateKey({})).rejects.toThrow(/Public key missing/)
  })
})

describe('archivePush.testConnection', () => {
  it('rejects when host is unset', async () => {
    const result = await caller.testConnection({})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/host and remoteUser/)
  })

  it('rejects when identity is missing', async () => {
    await caller.setConfig({
      enabled: false,
      host: 'nas.local',
      remoteUser: 'sp',
      remotePath: '/x',
      port: 22,
      identity: path.join(configDir, 'archive-push.id_ed25519'),
      include: ['raw'],
    })
    const result = await caller.testConnection({})
    expect(result.ok).toBe(false)
    expect(result.message).toMatch(/identity .* missing/)
  })

  it('returns ok=true when ssh succeeds', async () => {
    const identity = path.join(configDir, 'archive-push.id_ed25519')
    await writeFile(identity, 'PRIVATE')
    await caller.setConfig({
      enabled: true,
      host: 'nas.local',
      remoteUser: 'sp',
      remotePath: '/x',
      port: 2222,
      identity,
      include: ['raw'],
    })

    let observed: { cmd: string, args: readonly string[] } | null = null
    execMock.impl = (cmd, args) => {
      observed = { cmd, args }
      return { stdout: '', stderr: '' }
    }

    const result = await caller.testConnection({})
    expect(result.ok).toBe(true)
    expect(result.message).toBe('connection ok')
    if (!observed) throw new Error('execFile mock was not invoked')
    const seen = observed as { cmd: string, args: readonly string[] }
    expect(seen.cmd).toBe('ssh')
    // Verify BatchMode + accept-new are set so a hung password prompt cannot
    // happen on the daemon.
    expect(seen.args).toContain('BatchMode=yes')
    expect(seen.args).toContain('StrictHostKeyChecking=accept-new')
    // user@host and port are passed through
    expect(seen.args).toContain('sp@nas.local')
    expect(seen.args).toContain('2222')
  })

  it('returns ok=false carrying ssh stderr on failure', async () => {
    const identity = path.join(configDir, 'archive-push.id_ed25519')
    await writeFile(identity, 'PRIVATE')
    await caller.setConfig({
      enabled: true,
      host: 'nas.local',
      remoteUser: 'sp',
      remotePath: '/x',
      port: 22,
      identity,
      include: ['raw'],
    })

    execMock.impl = () => {
      const e = new Error('exit 255') as Error & { stderr?: string }
      e.stderr = 'Permission denied (publickey)'
      throw e
    }

    const result = await caller.testConnection({})
    expect(result.ok).toBe(false)
    expect(result.message).toBe('Permission denied (publickey)')
  })

  it('falls back to err.message when stderr is absent', async () => {
    const identity = path.join(configDir, 'archive-push.id_ed25519')
    await writeFile(identity, 'PRIVATE')
    await caller.setConfig({
      enabled: true,
      host: 'nas.local',
      remoteUser: 'sp',
      remotePath: '/x',
      port: 22,
      identity,
      include: ['raw'],
    })

    execMock.impl = () => {
      throw new Error('connect timeout')
    }

    const result = await caller.testConnection({})
    expect(result.ok).toBe(false)
    // execFile's callback strips Error -> ErrnoException-shaped object; the
    // router falls back to the err.message string when stderr is empty.
    expect(result.message).toMatch(/connect timeout|exit/i)
  })
})
