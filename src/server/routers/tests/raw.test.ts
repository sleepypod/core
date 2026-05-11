/**
 * Tests for the raw router — files filters/sorts safely-named .RAW entries,
 * deleteFile rejects bad filenames, symlinks, and the active/newest file,
 * diskUsage falls back gracefully when df is unavailable.
 *
 * fs/promises and child_process.execFile are fully mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  readdir: vi.fn(),
  stat: vi.fn(),
  lstat: vi.fn(),
  realpath: vi.fn(),
  unlink: vi.fn(),
}))

const execMock = vi.hoisted(() => ({
  execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (err: unknown, out: { stdout: string }) => void) => {
    // default: succeed with empty df output
    cb(null, { stdout: '' })
  }),
}))

vi.mock('node:fs/promises', () => ({ ...fsMock, default: fsMock }))
vi.mock('node:child_process', () => ({ execFile: execMock.execFile, default: { execFile: execMock.execFile } }))

const { rawRouter, listRawFiles } = await import('@/src/server/routers/raw')
const caller = rawRouter.createCaller({})

beforeEach(() => {
  fsMock.readdir.mockReset()
  fsMock.stat.mockReset()
  fsMock.lstat.mockReset()
  fsMock.realpath.mockReset()
  fsMock.unlink.mockReset()
  execMock.execFile.mockReset()
  execMock.execFile.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: '' }))
})

describe('listRawFiles helper', () => {
  it('filters non-RAW files and sorts newest first', async () => {
    fsMock.readdir.mockResolvedValue(['a.RAW', 'b.RAW', 'README.txt', 'evil/../escape.RAW'] as never)
    fsMock.stat.mockImplementation(async (p: unknown) => {
      const name = String(p).split('/').pop()
      if (name === 'a.RAW') return { size: 100, mtime: new Date('2025-01-01') } as never
      return { size: 200, mtime: new Date('2025-02-01') } as never
    })

    const out = await listRawFiles()
    // README.txt drops; the path-traversing entry doesn't match SAFE_FILENAME
    expect(out.map(f => f.name)).toEqual(['b.RAW', 'a.RAW'])
    expect(out[0].sizeBytes).toBe(200)
  })

  it('returns [] on ENOENT', async () => {
    const err = Object.assign(new Error('no dir'), { code: 'ENOENT' })
    fsMock.readdir.mockRejectedValue(err)

    const out = await listRawFiles()
    expect(out).toEqual([])
  })

  it('rethrows non-ENOENT errors', async () => {
    fsMock.readdir.mockRejectedValue(new Error('permission denied'))
    await expect(listRawFiles()).rejects.toThrow(/permission denied/)
  })
})

describe('raw.files', () => {
  it('passes through listRawFiles output', async () => {
    fsMock.readdir.mockResolvedValue(['a.RAW'] as never)
    fsMock.stat.mockResolvedValue({ size: 50, mtime: new Date('2025-01-01') } as never)

    const out = await caller.files({})
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe('a.RAW')
  })

  it('wraps unexpected errors', async () => {
    fsMock.readdir.mockRejectedValue(new Error('disk dead'))
    await expect(caller.files({})).rejects.toThrow(/Failed to list RAW files/)
  })
})

describe('raw.deleteFile', () => {
  it('rejects path-traversal-style names BEFORE touching fs', async () => {
    await expect(caller.deleteFile({ filename: '../escape.RAW' })).rejects.toThrow(/Invalid filename/)
    expect(fsMock.lstat).not.toHaveBeenCalled()
  })

  it('rejects names without a .RAW suffix', async () => {
    await expect(caller.deleteFile({ filename: 'random.txt' })).rejects.toThrow(/Invalid filename/)
  })

  it('rejects symlinks', async () => {
    fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => true } as never)
    await expect(caller.deleteFile({ filename: 'a.RAW' })).rejects.toThrow(/Path traversal detected/)
  })

  it('rejects when canonical path escapes RAW_DIR', async () => {
    fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false } as never)
    fsMock.realpath.mockImplementation(async (p: unknown) => {
      // canonical of file lands outside canonical of dir
      if (String(p).endsWith('a.RAW')) return '/elsewhere/a.RAW'
      return '/persistent'
    })
    await expect(caller.deleteFile({ filename: 'a.RAW' })).rejects.toThrow(/Path traversal detected/)
  })

  it('refuses to delete the active (newest) file', async () => {
    fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false } as never)
    fsMock.realpath.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('a.RAW')) return '/persistent/a.RAW'
      return '/persistent'
    })
    fsMock.readdir.mockResolvedValue(['a.RAW', 'b.RAW'] as never)
    fsMock.stat.mockImplementation(async (p: unknown) => {
      const name = String(p).split('/').pop()
      // a.RAW is the newest (highest mtime ISO)
      return { size: 1, mtime: name === 'a.RAW' ? new Date('2025-02-01') : new Date('2025-01-01') } as never
    })

    const result = await caller.deleteFile({ filename: 'a.RAW' })
    expect(result).toEqual({ deleted: false, message: 'Cannot delete the active (newest) RAW file' })
    expect(fsMock.unlink).not.toHaveBeenCalled()
  })

  it('returns "File not found" on ENOENT during the lstat probe', async () => {
    const err = Object.assign(new Error('no'), { code: 'ENOENT' })
    fsMock.lstat.mockRejectedValue(err)

    const result = await caller.deleteFile({ filename: 'a.RAW' })
    expect(result).toEqual({ deleted: false, message: 'File not found' })
  })

  it('deletes a non-active file', async () => {
    fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false } as never)
    fsMock.realpath.mockImplementation(async (p: unknown) => {
      if (String(p).endsWith('b.RAW')) return '/persistent/b.RAW'
      return '/persistent'
    })
    fsMock.readdir.mockResolvedValue(['a.RAW', 'b.RAW'] as never)
    fsMock.stat.mockImplementation(async (p: unknown) => {
      const name = String(p).split('/').pop()
      return { size: 1, mtime: name === 'a.RAW' ? new Date('2025-02-01') : new Date('2025-01-01') } as never
    })
    fsMock.unlink.mockResolvedValue(undefined as never)

    const result = await caller.deleteFile({ filename: 'b.RAW' })
    expect(result).toEqual({ deleted: true, message: 'Deleted b.RAW' })
    expect(fsMock.unlink).toHaveBeenCalledTimes(1)
  })
})

describe('raw.diskUsage', () => {
  it('parses df output when available and aggregates raw bytes', async () => {
    fsMock.readdir.mockResolvedValue(['a.RAW'] as never)
    fsMock.stat.mockResolvedValue({ size: 1234, mtime: new Date(0) } as never)
    execMock.execFile.mockImplementation((_f, _a, _o, cb) => {
      cb(null, { stdout: 'Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/sda1 1000 200 800 20% /persistent\n' })
    })

    const result = await caller.diskUsage({})
    expect(result.totalBytes).toBe(1000)
    expect(result.usedBytes).toBe(200)
    expect(result.availableBytes).toBe(800)
    expect(result.rawFileCount).toBe(1)
    expect(result.rawBytes).toBe(1234)
  })

  it('falls back to zero df totals when df is unavailable', async () => {
    fsMock.readdir.mockResolvedValue([] as never)
    execMock.execFile.mockImplementation((_f, _a, _o, cb) => cb(new Error('df: command not found'), { stdout: '' }))

    const result = await caller.diskUsage({})
    expect(result.totalBytes).toBe(0)
    expect(result.rawFileCount).toBe(0)
  })
})
