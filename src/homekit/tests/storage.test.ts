import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  clearPairings,
  getStorageDir,
  loadOrCreateIdentity,
  markIdentityPaired,
  probeSeedSources,
  readIdentityIfPresent,
  readPairedControllers,
  regenerateIdentity,
} from '../storage'

describe('homekit storage', () => {
  // Each case starts with an empty storage dir. getStorageDir() caches on
  // first call within the process, so wiping the directory contents (rather
  // than re-pointing the module) is the only knob that survives across
  // tests without monkey-patching the module exports.
  beforeEach(() => {
    const d = getStorageDir()
    for (const name of readdirSync(d)) rmSync(join(d, name), { force: true })
  })
  afterEach(() => {
    const d = getStorageDir()
    for (const name of readdirSync(d)) rmSync(join(d, name), { force: true })
  })

  it('creates a stable identity on first read and returns same on second', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)

    const a = loadOrCreateIdentity()
    expect(a.username).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/)
    expect(a.pincode).toMatch(/^\d{3}-\d{2}-\d{3}$/)
    expect(a.setupId).toMatch(/^[A-Z0-9]{4}$/)

    const b = loadOrCreateIdentity()
    expect(b).toEqual(a)
  })

  it('regenerate replaces identity', () => {
    const before = loadOrCreateIdentity()
    const after = regenerateIdentity()
    expect(after.username).not.toEqual(before.username)
    expect(after.pincode).not.toEqual(before.pincode)
  })

  it('rejects forbidden pincodes', () => {
    const FORBIDDEN = ['000-00-000', '111-11-111', '123-45-678']
    // 200 trials should never produce one of these.
    for (let i = 0; i < 50; i++) {
      const id = regenerateIdentity()
      expect(FORBIDDEN).not.toContain(id.pincode)
    }
  })

  it('clearPairings removes AccessoryInfo + IdentifierCache for the username', () => {
    const dir = getStorageDir()
    const username = 'AA:BB:CC:11:22:33'
    const key = 'AABBCC112233'
    const accessory = join(dir, `AccessoryInfo.${key}.json`)
    const identifiers = join(dir, `IdentifierCache.${key}.json`)
    writeFileSync(accessory, '{}')
    writeFileSync(identifiers, '{}')

    clearPairings(username)

    expect(existsSync(accessory)).toBe(false)
    expect(existsSync(identifiers)).toBe(false)
  })

  it('clearPairings is a no-op when files are absent', () => {
    expect(() => clearPairings('11:22:33:44:55:66')).not.toThrow()
  })

  it('clearPairings preserves identity.json', () => {
    const dir = getStorageDir()
    const id = loadOrCreateIdentity()
    clearPairings(id.username)
    expect(existsSync(join(dir, 'identity.json'))).toBe(true)
  })

  it('readPairedControllers returns [] when AccessoryInfo missing', () => {
    expect(readPairedControllers('AA:BB:CC:11:22:33')).toEqual([])
  })

  it('readPairedControllers parses pairedClients keys', () => {
    const dir = getStorageDir()
    const username = '11:22:33:44:55:66'
    const file = join(dir, 'AccessoryInfo.112233445566.json')
    writeFileSync(file, JSON.stringify({
      pairedClients: { 'controller-a': 'pubkey1', 'controller-b': 'pubkey2' },
    }))
    expect(readPairedControllers(username).sort()).toEqual(['controller-a', 'controller-b'])
    rmSync(file, { force: true })
  })

  it('readPairedControllers tolerates malformed JSON', () => {
    const dir = getStorageDir()
    const username = '99:88:77:66:55:44'
    const file = join(dir, 'AccessoryInfo.998877665544.json')
    writeFileSync(file, '{not valid')
    expect(readPairedControllers(username)).toEqual([])
    rmSync(file, { force: true })
  })

  it('derived identity username has the locally-administered bit set', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)
    const id = loadOrCreateIdentity()
    const firstByte = parseInt(id.username.slice(0, 2), 16)
    expect(firstByte & 0x02).toBe(0x02)
  })

  it('writes identity.json with derivedFrom + rotation when freshly derived', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)
    loadOrCreateIdentity()
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    expect(typeof parsed.derivedFrom).toBe('string')
    expect(parsed.rotation).toBe(0)
    expect(typeof parsed.derivedAt).toBe('number')
  })

  it('preserves legacy identity (no derivedFrom) without re-deriving', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    const legacy = {
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '123-45-678',
      setupId: 'WXYZ',
    }
    writeFileSync(file, JSON.stringify(legacy), { mode: 0o600 })
    // 123-45-678 is in the rejected set; the legacy preservation path
    // should still return it verbatim (we are not re-deriving).
    const id = loadOrCreateIdentity()
    expect(id.username).toBe(legacy.username)
    expect(id.pincode).toBe(legacy.pincode)
    expect(id.setupId).toBe(legacy.setupId)
    expect(id.derivedFrom).toBeUndefined()
    rmSync(file, { force: true })
  })

  it('regenerate increments rotation when prior rotation is recorded', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)
    const a = loadOrCreateIdentity()
    expect(a.rotation).toBe(0)
    const b = regenerateIdentity()
    expect(b.rotation).toBe(1)
    const c = regenerateIdentity()
    expect(c.rotation).toBe(2)
  })

  it('regenerate produces different identity at each rotation', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)
    loadOrCreateIdentity()
    const seen = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const r = regenerateIdentity()
      seen.add(r.username)
    }
    expect(seen.size).toBe(10)
  })

  it('readIdentityIfPresent returns null when identity.json is absent', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)
    expect(readIdentityIfPresent()).toBeNull()
  })

  it('readIdentityIfPresent returns the parsed identity when present', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    const payload = {
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '321-54-987',
      setupId: 'ABCD',
      derivedFrom: 'mmc-cid' as const,
      rotation: 4,
    }
    writeFileSync(file, JSON.stringify(payload))
    expect(readIdentityIfPresent()).toEqual(payload)
  })

  it('readIdentityIfPresent returns null when JSON is unparseable', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    writeFileSync(file, '{ broken')
    expect(readIdentityIfPresent()).toBeNull()
  })

  it('readIdentityIfPresent returns null when shape is incomplete', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    writeFileSync(file, JSON.stringify({ username: 'AA:BB:CC:DD:EE:FF' }))
    expect(readIdentityIfPresent()).toBeNull()
  })

  it('loadOrCreateIdentity backs up the corrupt file before regenerating', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    writeFileSync(file, '{ corrupt')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const id = loadOrCreateIdentity()
      expect(id.username).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/)
      const backups = readdirSync(dir).filter(n => n.startsWith('identity.json.corrupt.'))
      expect(backups.length).toBeGreaterThan(0)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/backed up to/),
        expect.anything(),
      )
    }
    finally {
      warnSpy.mockRestore()
    }
  })

  it('initHapStorage is idempotent across repeated calls', async () => {
    // First call triggers the hap-nodejs setCustomStoragePath; second is a no-op
    // because the module caches the init flag on globalThis.
    const { initHapStorage } = await import('../storage')
    const g = globalThis as Record<string, unknown>
    const key = '__sp_homekit_hapInit__'
    g[key] = undefined
    initHapStorage()
    expect(g[key]).toBe(true)
    // Calling again should remain truthy and not throw
    expect(() => initHapStorage()).not.toThrow()
    expect(g[key]).toBe(true)
  })

  it('markIdentityPaired sets wasPaired=true and is idempotent on second call', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    const before = loadOrCreateIdentity()
    expect(before.wasPaired).toBeUndefined()

    markIdentityPaired()
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.wasPaired).toBe(true)

    // Re-mark must not corrupt the file or rotate the identity fields.
    markIdentityPaired()
    const again = JSON.parse(readFileSync(file, 'utf8'))
    expect(again).toEqual(after)
  })

  it('markIdentityPaired silently no-ops when identity.json is absent', () => {
    const dir = getStorageDir()
    const file = join(dir, 'identity.json')
    if (existsSync(file)) rmSync(file)
    expect(() => markIdentityPaired()).not.toThrow()
    expect(existsSync(file)).toBe(false)
  })

  it('probeSeedSources reports each chain entry without throwing', () => {
    const probe = probeSeedSources()
    expect(probe.resolved).toMatch(/^(mmc-cid|mmc-serial|machine-id|random-dev)$/)
    expect(probe.sources.length).toBeGreaterThanOrEqual(4)
    const names = probe.sources.map(s => s.source)
    expect(names).toContain('mmc-cid')
    expect(names).toContain('mmc-serial')
    expect(names).toContain('machine-id')
    expect(names).toContain('random-dev')
    for (const s of probe.sources) {
      expect(typeof s.present).toBe('boolean')
      expect(typeof s.readable).toBe('boolean')
      expect(typeof s.looksDegenerate).toBe('boolean')
    }
  })
})
