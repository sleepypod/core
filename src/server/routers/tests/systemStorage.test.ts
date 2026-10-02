/**
 * Tests for system.getStorage / system.freeStorage — df -P parsing, one du
 * call for every category, the sp-storage-cleanup dry-run plan, raw-history
 * span from archive mtimes, and graceful fallbacks when the helper is missing.
 *
 * child_process.execFile, node:fs and node:fs/promises are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

type ExecHandler = (file: string, args: string[]) => string | Error

const mocks = vi.hoisted(() => ({
  handler: (() => '') as (file: string, args: string[]) => string | Error,
  calls: [] as Array<{ file: string, args: string[] }>,
  helperInstalled: true,
}))

vi.mock('node:child_process', () => {
  const execFile = vi.fn((file: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as (e: unknown, o: { stdout: string, stderr: string }) => void
    mocks.calls.push({ file, args })
    const out = mocks.handler(file, args)
    if (out instanceof Error) cb(out, { stdout: '', stderr: '' })
    else cb(null, { stdout: out, stderr: '' })
  })
  return { execFile, spawn: vi.fn(), default: { execFile, spawn: vi.fn() } }
})

const fsSync = vi.hoisted(() => ({
  accessSync: vi.fn((p: string) => {
    if (p === '/usr/local/bin/sp-storage-cleanup' && mocks.helperInstalled) return
    throw new Error('ENOENT')
  }),
  constants: { X_OK: 1 },
}))
vi.mock('node:fs', () => ({ ...fsSync, default: fsSync }))

const fsp = vi.hoisted(() => ({
  readdir: vi.fn(async (): Promise<string[]> => []),
  readFile: vi.fn(async (): Promise<string> => { throw new Error('ENOENT') }),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  realpath: vi.fn(async () => '/persistent/sleepypod-releases/live'),
  stat: vi.fn(async (p: string) => ({ mtimeMs: p.includes('A.RAW') ? Date.UTC(2026, 8, 14) : Date.UTC(2026, 8, 28) })),
}))
vi.mock('node:fs/promises', () => ({ ...fsp, default: fsp }))

const { systemRouter } = await import('@/src/server/routers/system')
const caller = systemRouter.createCaller({})

const PLAN = JSON.stringify({
  dryRun: true,
  items: [
    { path: '/persistent/sleepypod-rollback.abc', bytes: 800 * 1024, reason: 'leftover rollback copy' },
    { path: '/persistent/sleepypod-releases/old', bytes: 900 * 1024, reason: 'old release build' },
    { path: '/persistent/sleepypod-core/node_modules', bytes: 1000 * 1024, reason: 'unused node_modules' },
    { path: '/persistent/sleepypod-data/biometrics.db.bak.1', bytes: 40 * 1024, reason: 'old biometrics.db backup' },
  ],
  freedBytes: 2740 * 1024,
})

function pod(extra: ExecHandler = () => '') {
  mocks.handler = (file, args) => {
    const override = extra(file, args)
    if (override) return override
    if (file === 'df') return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/mmcblk0p8  15000000  12000000  3000000  80% /persistent\n'
    if (file === '/usr/local/bin/sp-storage-cleanup') return PLAN
    if (file === 'du') {
      return [
        '3400000\t/persistent/biometrics-archive',
        '700000\t/persistent/sleepypod-releases/live',
        '1100000\t/persistent/swapfile',
        '60000\t/persistent/sleepypod-data/biometrics.db',
        '8000\t/persistent/sleepypod-data/sleepypod.db',
        '800\t/persistent/sleepypod-rollback.abc',
        '500\t/persistent/sleepypod-releases/old',
        '1000\t/persistent/sleepypod-core/node_modules',
        '40\t/persistent/sleepypod-data/biometrics.db.bak.1',
      ].join('\n')
    }
    return ''
  }
}

beforeEach(() => {
  mocks.calls = []
  mocks.helperInstalled = true
  fsp.readdir.mockReset().mockResolvedValue(['A.RAW.gz', 'B.RAW.gz', 'notes.txt'])
  pod()
})

describe('system.getStorage', () => {
  it('reports /persistent usage from df -P in 1K blocks', async () => {
    const r = await caller.getStorage({})
    expect(mocks.calls.find(c => c.file === 'df')?.args).toEqual(['-P', '-k', '/persistent'])
    expect(r.persistent).toEqual({ totalBytes: 15_000_000 * 1024, usedBytes: 12_000_000 * 1024, availableBytes: 3_000_000 * 1024, usedPercent: 80 })
    expect(r.prunerTargetPercent).toBe(80)
  })

  it('sizes every category in a single du call and puts the remainder in other', async () => {
    const r = await caller.getStorage({})
    const du = mocks.calls.filter(c => c.file === 'du')
    expect(du).toHaveLength(1)
    expect(du[0].args.slice(0, 2)).toEqual(['-sk', '--'])
    const seg = Object.fromEntries(r.segments.map(s => [s.key, s.bytes / 1024]))
    expect(seg.rawArchive).toBe(3_400_000)
    expect(seg.app).toBe(700_000)
    expect(seg.swap).toBe(1_100_000)
    expect(seg.database).toBe(68_000)
    // du's figure for the reclaimable paths (hardlinks counted once), not the helper's.
    expect(seg.reclaimable).toBe(2340)
    expect(seg.other).toBe(12_000_000 - 3_400_000 - 700_000 - 1_100_000 - 68_000 - 2340)
  })

  it('lists the dry-run plan with a kind per item', async () => {
    const r = await caller.getStorage({})
    const call = mocks.calls.find(c => c.file === '/usr/local/bin/sp-storage-cleanup')
    expect(call?.args).toEqual(['--dry-run', '--json', '--include-db-backups'])
    expect(r.reclaimable.available).toBe(true)
    expect(r.reclaimable.totalBytes).toBe(2740 * 1024)
    expect(r.reclaimable.items.map(i => i.kind)).toEqual(['temp', 'release', 'modules', 'backup'])
  })

  it('measures raw history from the oldest and newest archive', async () => {
    const r = await caller.getStorage({})
    expect(r.rawHistory).toEqual({
      fileCount: 2,
      oldest: '2026-09-14T00:00:00.000Z',
      newest: '2026-09-28T00:00:00.000Z',
      days: 14,
    })
  })

  it('degrades when the helper is missing, df fails and the archive is absent', async () => {
    mocks.helperInstalled = false
    fsp.readdir.mockRejectedValue(new Error('ENOENT'))
    pod(file => (file === 'df' || file === 'du' ? new Error('not linux') : ''))
    const r = await caller.getStorage({})
    expect(r.reclaimable).toEqual({ available: false, items: [], totalBytes: 0 })
    expect(r.persistent.totalBytes).toBe(0)
    expect(r.rawHistory.days).toBeNull()
    expect(r.segments.every(s => s.bytes === 0)).toBe(true)
  })

  it('marks the plan unavailable when the helper errors', async () => {
    pod(file => (file === '/usr/local/bin/sp-storage-cleanup' ? new Error('boom') : ''))
    expect((await caller.getStorage({})).reclaimable.available).toBe(false)
  })
})

describe('system.freeStorage', () => {
  it('runs the helper through sudo -n and returns bytes freed', async () => {
    pod(file => (file === 'sudo' ? JSON.stringify({ dryRun: false, items: [{ path: '/persistent/x', bytes: 5, reason: '' }], freedBytes: 5 }) : ''))
    await expect(caller.freeStorage({})).resolves.toEqual({ freedBytes: 5, removed: 1 })
    expect(mocks.calls.find(c => c.file === 'sudo')?.args).toEqual(['-n', '/usr/local/bin/sp-storage-cleanup', '--json'])
  })

  it('passes --include-db-backups only when asked', async () => {
    pod(file => (file === 'sudo' ? '{"items":[],"freedBytes":0}' : ''))
    await caller.freeStorage({ includeDbBackups: true })
    expect(mocks.calls.find(c => c.file === 'sudo')?.args).toContain('--include-db-backups')
  })

  it('wraps failures, including a missing helper', async () => {
    pod(file => (file === 'sudo' ? new Error('a password is required') : ''))
    await expect(caller.freeStorage({})).rejects.toThrow(/Storage cleanup failed: a password is required/)
    mocks.helperInstalled = false
    await expect(caller.freeStorage({})).rejects.toThrow(/not installed/)
  })
})
