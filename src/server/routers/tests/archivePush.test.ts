/**
 * Unit tests for the archive-push router. Covers conf parsing/rendering,
 * getConfig/setConfig roundtrip on a temp dir, and behaviour when the conf
 * is absent. Excludes ssh-keygen / ssh — those shell out to binaries we'd
 * have to mock and provide little signal in a unit run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

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
  await rm(path.join(configDir, 'archive-push.id_ed25519.pub'), { force: true })
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

  it('strips matched surrounding quotes', () => {
    const result = parseConf('REMOTE_PATH="/volume1/sleepypod"\nINCLUDE=\'raw,db\'')
    expect(result.REMOTE_PATH).toBe('/volume1/sleepypod')
    expect(result.INCLUDE).toBe('raw,db')
  })

  it('skips lines without =', () => {
    const result = parseConf('ENABLED=true\nbogus line\nHOST=h')
    expect(result).toEqual({ ENABLED: 'true', HOST: 'h' })
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
})
