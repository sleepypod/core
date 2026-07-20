import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const state = vi.hoisted(() => {
  const originalHomekitDir = process.env.HOMEKIT_DIR
  process.env.HOMEKIT_DIR = '/virtual/homekit'

  const existing = new Set<string>()
  const files = new Map<string, string>()
  const readErrors = new Map<string, unknown>()
  const renameErrors = new Map<string, unknown>()

  const existsSync = vi.fn((file: string) => existing.has(file))
  const mkdirSync = vi.fn((dir: string) => {
    existing.add(dir)
  })
  const readFileSync = vi.fn((file: string) => {
    if (readErrors.has(file)) throw readErrors.get(file)
    if (!files.has(file)) {
      throw Object.assign(new Error(`missing ${file}`), { code: 'ENOENT' })
    }
    return files.get(file) as string
  })
  const writeFileSync = vi.fn((file: string, value: string) => {
    files.set(file, String(value))
    existing.add(file)
  })
  const renameSync = vi.fn((from: string, to: string) => {
    if (renameErrors.has(from)) throw renameErrors.get(from)
    const value = files.get(from)
    if (value !== undefined) files.set(to, value)
    files.delete(from)
    existing.delete(from)
    existing.add(to)
  })
  const rmSync = vi.fn((file: string) => {
    files.delete(file)
    existing.delete(file)
  })
  const hapPath = vi.fn()

  const bag: {
    existing: Set<string>
    files: Map<string, string>
    readErrors: Map<string, unknown>
    renameErrors: Map<string, unknown>
    existsSync: typeof existsSync
    mkdirSync: typeof mkdirSync
    readFileSync: typeof readFileSync
    writeFileSync: typeof writeFileSync
    renameSync: typeof renameSync
    rmSync: typeof rmSync
    hapPath: typeof hapPath
    deriveImpl: (info: string, length: number) => Buffer
    hkdfSync: ReturnType<typeof vi.fn>
    randomBytes: ReturnType<typeof vi.fn>
    originalHomekitDir: string | undefined
  } = {
    existing,
    files,
    readErrors,
    renameErrors,
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    rmSync,
    hapPath,
    deriveImpl: (_info, length) => Buffer.alloc(length, 1),
    hkdfSync: vi.fn(),
    randomBytes: vi.fn((length: number) => Buffer.alloc(length, 0xab)),
    originalHomekitDir,
  }
  bag.hkdfSync.mockImplementation(
    (_digest: string, _seed: string, _salt: string, info: string, length: number) =>
      bag.deriveImpl(String(info), length),
  )
  return bag
})

vi.mock('node:fs', () => {
  const mock = {
    existsSync: state.existsSync,
    mkdirSync: state.mkdirSync,
    readFileSync: state.readFileSync,
    writeFileSync: state.writeFileSync,
    renameSync: state.renameSync,
    rmSync: state.rmSync,
  }
  return { ...mock, default: mock }
})

vi.mock('node:crypto', () => {
  const mock = { hkdfSync: state.hkdfSync, randomBytes: state.randomBytes }
  return { ...mock, default: mock }
})

vi.mock('hap-nodejs', () => ({
  HAPStorage: { setCustomStoragePath: state.hapPath },
}))

import {
  getStorageDir,
  initHapStorage,
  loadOrCreateIdentity,
  markIdentityPaired,
  probeSeedSources,
  readIdentityIfPresent,
  readPairedControllers,
  readSeed,
  regenerateIdentity,
} from '../storage'

const identityFile = '/virtual/homekit/identity.json'
const seedPaths = {
  cid: '/sys/block/mmcblk0/device/cid',
  serial: '/sys/block/mmcblk0/device/serial',
  machine: '/etc/machine-id',
}

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('not found'), { code: 'ENOENT' })
}

function resetSingletons(): void {
  const globals = globalThis as Record<string, unknown>
  delete globals.__sp_homekit_cachedDir__
  delete globals.__sp_homekit_hapInit__
}

describe('homekit storage mutation contracts', () => {
  beforeEach(() => {
    process.env.HOMEKIT_DIR = '/virtual/homekit'
    resetSingletons()
    state.existing.clear()
    state.files.clear()
    state.readErrors.clear()
    state.renameErrors.clear()
    state.existsSync.mockClear()
    state.mkdirSync.mockClear()
    state.readFileSync.mockClear()
    state.writeFileSync.mockClear()
    state.renameSync.mockClear()
    state.rmSync.mockClear()
    state.hapPath.mockClear()
    state.hkdfSync.mockClear()
    state.randomBytes.mockClear()
    state.deriveImpl = (_info, length) => Buffer.alloc(length, 1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetSingletons()
    if (state.originalHomekitDir === undefined) {
      delete process.env.HOMEKIT_DIR
    }
    else {
      process.env.HOMEKIT_DIR = state.originalHomekitDir
    }
  })

  it('chooses, creates, and caches the persistent directory exactly', () => {
    state.existing.add('/persistent')

    expect(getStorageDir()).toBe('/virtual/homekit')
    expect(state.mkdirSync).toHaveBeenCalledWith('/virtual/homekit', { recursive: true })

    state.existing.delete('/persistent')
    expect(getStorageDir()).toBe('/virtual/homekit')
    expect(state.mkdirSync).toHaveBeenCalledOnce()
  })

  it('chooses an existing development directory without recreating it', () => {
    const devDir = join(process.cwd(), '.homekit-data')
    state.existing.add(devDir)

    expect(getStorageDir()).toBe(devDir)
    expect(state.mkdirSync).not.toHaveBeenCalled()
  })

  it('initializes HAP storage exactly once with the selected path', () => {
    state.existing.add('/persistent')

    initHapStorage()
    initHapStorage()

    expect(state.hapPath).toHaveBeenCalledOnce()
    expect(state.hapPath).toHaveBeenCalledWith('/virtual/homekit')
  })

  it.each([
    ['A000', false],
    ['000A', false],
    ['Afff', false],
    ['fffA', false],
    ['', true],
    ['0000', true],
    ['fFfF', true],
  ])('classifies the seed %j as degenerate=%s', (value, degenerate) => {
    state.files.set(seedPaths.cid, value)
    state.existing.add(seedPaths.cid)

    const seed = readSeed()

    if (degenerate) {
      expect(seed).toEqual({ source: 'random-dev', value: 'ab'.repeat(32) })
      expect(state.randomBytes).toHaveBeenCalledWith(32)
    }
    else {
      expect(seed).toEqual({ source: 'mmc-cid', value })
      expect(state.randomBytes).not.toHaveBeenCalled()
    }
  })

  it('walks the ordered seed chain, trimming the first usable value', () => {
    state.files.set(seedPaths.cid, '0000')
    state.files.set(seedPaths.serial, 'ffff')
    state.files.set(seedPaths.machine, '  machine-seed\n')

    expect(readSeed()).toEqual({ source: 'machine-id', value: 'machine-seed' })
    expect(state.readFileSync.mock.calls.map(call => call[0])).toEqual([
      seedPaths.cid,
      seedPaths.serial,
      seedPaths.machine,
    ])
  })

  it('reports exact seed presence, readability, degeneracy, and resolution', () => {
    state.files.set(seedPaths.cid, 'usable-cid')
    state.readErrors.set(seedPaths.serial, Object.assign(new Error('denied'), { code: 'EACCES' }))
    state.readErrors.set(seedPaths.machine, enoent())

    expect(probeSeedSources()).toEqual({
      resolved: 'mmc-cid',
      sources: [
        { source: 'mmc-cid', path: seedPaths.cid, present: true, readable: true, looksDegenerate: false },
        { source: 'mmc-serial', path: seedPaths.serial, present: true, readable: false, looksDegenerate: false },
        { source: 'machine-id', path: seedPaths.machine, present: false, readable: false, looksDegenerate: false },
        { source: 'random-dev', path: null, present: true, readable: true, looksDegenerate: false },
      ],
    })
  })

  it('reports random-dev when every durable seed is unusable', () => {
    state.files.set(seedPaths.cid, '0000')
    state.files.set(seedPaths.serial, 'ffff')
    state.readErrors.set(seedPaths.machine, enoent())

    expect(probeSeedSources().resolved).toBe('random-dev')
  })

  it('trims a probed seed before classifying it as degenerate', () => {
    state.files.set(seedPaths.cid, '0000\n')
    state.readErrors.set(seedPaths.serial, enoent())
    state.readErrors.set(seedPaths.machine, enoent())

    const probe = probeSeedSources()

    expect(probe.sources[0]).toEqual({
      source: 'mmc-cid',
      path: seedPaths.cid,
      present: true,
      readable: true,
      looksDegenerate: true,
    })
    expect(probe.resolved).toBe('random-dev')
  })

  it('derives every identity field, retries a forbidden pincode, and writes securely', () => {
    state.existing.add('/persistent')
    state.files.set(seedPaths.cid, 'seed')
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_123_999)
    state.deriveImpl = (info, length) => {
      if (info === 'username/0') return Buffer.from([1, 2, 3, 4, 5, 6])
      if (info === 'pincode/0/0') {
        const rejected = Buffer.alloc(4)
        rejected.writeUInt32BE(12_345_678)
        return rejected
      }
      if (info === 'pincode/0/1') {
        const accepted = Buffer.alloc(4)
        accepted.writeUInt32BE(12_345_679)
        return accepted
      }
      if (info === 'setupid/0') return Buffer.from([0, 25, 26, 35])
      return Buffer.alloc(length)
    }

    try {
      const identity = loadOrCreateIdentity()

      expect(identity).toEqual({
        username: '02:02:03:04:05:06',
        pincode: '123-45-679',
        setupId: 'AZ09',
        derivedFrom: 'mmc-cid',
        derivedAt: 1_700_000_123,
        rotation: 0,
      })
      expect(state.hkdfSync.mock.calls.map(call => call[3])).toEqual([
        'username/0',
        'pincode/0/0',
        'pincode/0/1',
        'setupid/0',
      ])
      expect(state.writeFileSync).toHaveBeenCalledWith(
        identityFile,
        JSON.stringify(identity, null, 2),
        { mode: 0o600 },
      )
    }
    finally {
      now.mockRestore()
    }
  })

  it('skips the read/backup path entirely and logs the seed source on a fresh pod', () => {
    state.existing.add('/persistent')
    state.files.set(seedPaths.cid, 'seed')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      loadOrCreateIdentity()

      expect(state.readFileSync).not.toHaveBeenCalledWith(identityFile, 'utf8')
      expect(state.renameSync).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('[homekit] derived identity from mmc-cid (rotation=0)')
    }
    finally {
      log.mockRestore()
    }
  })

  it.each([
    { pincode: '123-45-678', setupId: 'ABCD' },
    { username: 'AA:BB:CC:DD:EE:FF', setupId: 'ABCD' },
    { username: 'AA:BB:CC:DD:EE:FF', pincode: '123-45-678' },
  ])('re-derives rather than returning a stored identity missing one field: %j', (partial) => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, JSON.stringify(partial))
    state.files.set(seedPaths.cid, 'seed')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    try {
      const identity = loadOrCreateIdentity()

      expect(identity.derivedFrom).toBe('mmc-cid')
      expect(identity.rotation).toBe(0)
      expect(state.writeFileSync).toHaveBeenCalledWith(
        identityFile,
        JSON.stringify(identity, null, 2),
        { mode: 0o600 },
      )
    }
    finally {
      log.mockRestore()
    }
  })

  it('stops pincode derivation after exactly 32 rejected candidates', () => {
    state.existing.add('/persistent')
    state.files.set(seedPaths.cid, 'seed')
    state.deriveImpl = (info, length) => {
      if (info.startsWith('pincode/')) return Buffer.alloc(4)
      return Buffer.alloc(length, 1)
    }

    expect(() => loadOrCreateIdentity()).toThrow('homekit pincode derivation exhausted retry budget')
    expect(state.hkdfSync.mock.calls.filter(call => String(call[3]).startsWith('pincode/'))).toHaveLength(32)
    expect(state.writeFileSync).not.toHaveBeenCalled()
  })

  it.each([
    { pincode: '123-45-678', setupId: 'ABCD' },
    { username: 'AA:BB:CC:DD:EE:FF', setupId: 'ABCD' },
    { username: 'AA:BB:CC:DD:EE:FF', pincode: '123-45-678' },
  ])('rejects an identity missing one required field: %j', (partial) => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, JSON.stringify(partial))

    expect(readIdentityIfPresent()).toBeNull()
  })

  it('never touches the disk when identity.json is absent', () => {
    state.existing.add('/persistent')

    expect(readIdentityIfPresent()).toBeNull()
    expect(state.readFileSync).not.toHaveBeenCalledWith(identityFile, 'utf8')
  })

  it('backs up malformed identity JSON with the exact timestamp and warning', () => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, '{broken')
    state.files.set(seedPaths.cid, 'seed')
    const now = vi.spyOn(Date, 'now').mockReturnValue(4242)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      loadOrCreateIdentity()

      expect(state.renameSync).toHaveBeenCalledWith(identityFile, `${identityFile}.corrupt.4242`)
      expect(warn).toHaveBeenCalledWith(
        `[homekit] identity.json unparseable, backed up to ${identityFile}.corrupt.4242, regenerating:`,
        expect.stringContaining('JSON'),
      )
    }
    finally {
      warn.mockRestore()
      now.mockRestore()
    }
  })

  it('warns with the backup error when corrupt identity preservation fails', () => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, '{broken')
    state.files.set(seedPaths.cid, 'seed')
    const backupError = new Error('read-only filesystem')
    state.renameErrors.set(identityFile, backupError)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    loadOrCreateIdentity()

    expect(warn).toHaveBeenCalledWith(
      '[homekit] identity.json unparseable; backup also failed, regenerating:',
      'read-only filesystem',
    )
  })

  it('reads paired controller keys and uses the normalized accessory filename', () => {
    state.existing.add('/persistent')
    const file = '/virtual/homekit/AccessoryInfo.AABBCCDDEEFF.json'
    state.existing.add(file)
    state.files.set(file, JSON.stringify({ pairedClients: { beta: {}, alpha: {} } }))

    expect(readPairedControllers('aa:bb:cc:dd:ee:ff')).toEqual(['beta', 'alpha'])
    expect(state.readFileSync).toHaveBeenCalledWith(file, 'utf8')
  })

  it('never reads an absent accessory info file', () => {
    state.existing.add('/persistent')

    expect(readPairedControllers('AA:BB:CC:DD:EE:FF')).toEqual([])
    expect(state.readFileSync).not.toHaveBeenCalled()
  })

  it('marks only a complete identity as paired and preserves every field', () => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    const identity = {
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '123-45-678',
      setupId: 'ABCD',
      rotation: 7,
    }
    state.files.set(identityFile, JSON.stringify(identity))

    markIdentityPaired()

    expect(JSON.parse(state.files.get(identityFile) as string)).toEqual({ ...identity, wasPaired: true })
    expect(state.writeFileSync).toHaveBeenCalledWith(
      identityFile,
      JSON.stringify({ ...identity, wasPaired: true }, null, 2),
      { mode: 0o600 },
    )
  })

  it.each([
    { pincode: '123-45-678', setupId: 'ABCD' },
    { username: 'AA:BB:CC:DD:EE:FF', setupId: 'ABCD' },
    { username: 'AA:BB:CC:DD:EE:FF', pincode: '123-45-678' },
  ])('does not mark an incomplete identity as paired: %j', (partial) => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, JSON.stringify(partial))

    markIdentityPaired()

    expect(state.writeFileSync).not.toHaveBeenCalled()
  })

  it('skips the rewrite when the paired marker is already set', () => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, JSON.stringify({
      username: 'AA:BB:CC:DD:EE:FF',
      pincode: '123-45-678',
      setupId: 'ABCD',
      wasPaired: true,
    }))

    markIdentityPaired()

    expect(state.writeFileSync).not.toHaveBeenCalled()
  })

  it('returns silently, without reading or warning, when identity.json is absent', () => {
    state.existing.add('/persistent')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      markIdentityPaired()

      expect(state.readFileSync).not.toHaveBeenCalled()
      expect(state.writeFileSync).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    }
    finally {
      warn.mockRestore()
    }
  })

  it.each([
    [undefined, 0],
    ['3', 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
    [4, 5],
  ])('regenerates from prior rotation %s to exact rotation %s', (previous, expected) => {
    state.existing.add('/persistent')
    state.existing.add(identityFile)
    state.files.set(identityFile, JSON.stringify({ rotation: previous }))
    state.files.set(seedPaths.cid, 'seed')

    const identity = regenerateIdentity()

    expect(identity.rotation).toBe(expected)
    expect(state.hkdfSync.mock.calls.map(call => call[3])).toContain(`username/${expected}`)
  })

  it('does not probe an absent identity file for a prior rotation', () => {
    state.existing.add('/persistent')
    state.files.set(seedPaths.cid, 'seed')

    expect(regenerateIdentity().rotation).toBe(0)
    expect(state.readFileSync).not.toHaveBeenCalledWith(identityFile, 'utf8')
  })
})
