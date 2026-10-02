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

  it('uses Unknown error for a non-Error listing rejection', async () => {
    fsMock.readdir.mockRejectedValue('filesystem unavailable')
    await expect(caller.files({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to list RAW files: Unknown error',
    })
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
    await expect(caller.deleteFile({ filename: 'a.RAW' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Path traversal detected',
    })
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

  it('deletes a valid file when the directory has no other RAW entries', async () => {
    fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false } as never)
    fsMock.realpath.mockImplementation(async (p: unknown) => String(p).endsWith('only.RAW')
      ? '/persistent/only.RAW'
      : '/persistent')
    fsMock.readdir.mockResolvedValue([] as never)
    fsMock.unlink.mockResolvedValue(undefined as never)

    await expect(caller.deleteFile({ filename: 'only.RAW' })).resolves.toEqual({
      deleted: true,
      message: 'Deleted only.RAW',
    })
    expect(fsMock.unlink).toHaveBeenCalledWith('/persistent/only.RAW')
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
    expect(execMock.execFile).toHaveBeenCalledWith(
      'df',
      ['-B1', '/persistent'],
      { timeout: 5000 },
      expect.any(Function),
    )
  })

  it('trims leading blank lines and splits runs of df whitespace', async () => {
    fsMock.readdir.mockResolvedValue([] as never)
    execMock.execFile.mockImplementation((_f, _a, _o, cb) => {
      cb(null, { stdout: '\nFilesystem   1B-blocks   Used   Available Use% Mounted\n/dev/root    4096        1024   3072      25%  /persistent\n' })
    })

    await expect(caller.diskUsage({})).resolves.toEqual({
      totalBytes: 4096,
      usedBytes: 1024,
      availableBytes: 3072,
      rawFileCount: 0,
      rawBytes: 0,
    })
  })

  it('falls back to zero df totals when df is unavailable', async () => {
    fsMock.readdir.mockResolvedValue([] as never)
    execMock.execFile.mockImplementation((_f, _a, _o, cb) => cb(new Error('df: command not found'), { stdout: '' }))

    const result = await caller.diskUsage({})
    expect(result.totalBytes).toBe(0)
    expect(result.rawFileCount).toBe(0)
  })

  it('wraps unexpected listRawFiles failure as INTERNAL_SERVER_ERROR', async () => {
    fsMock.readdir.mockRejectedValue(new Error('disk on fire'))
    await expect(caller.diskUsage({})).rejects.toThrow(/Failed to get disk usage/)
  })

  it('uses Unknown error for a non-Error disk-usage failure', async () => {
    fsMock.readdir.mockRejectedValue({ offline: true })
    await expect(caller.diskUsage({})).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to get disk usage: Unknown error',
    })
  })
})

describe('raw.deleteFile error wrappers', () => {
  it('wraps non-ENOENT unlink failure as INTERNAL_SERVER_ERROR', async () => {
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
    fsMock.unlink.mockRejectedValue(new Error('EBUSY: locked'))

    await expect(caller.deleteFile({ filename: 'b.RAW' })).rejects.toThrow(/Failed to delete file/)
  })

  it('uses Unknown error for a non-Error unlink failure', async () => {
    fsMock.lstat.mockResolvedValue({ isSymbolicLink: () => false } as never)
    fsMock.realpath.mockImplementation(async (p: unknown) => String(p).endsWith('b.RAW')
      ? '/persistent/b.RAW'
      : '/persistent')
    fsMock.readdir.mockResolvedValue(['a.RAW', 'b.RAW'] as never)
    fsMock.stat.mockImplementation(async (p: unknown) => ({
      size: 1,
      mtime: String(p).endsWith('a.RAW') ? new Date('2025-02-01') : new Date('2025-01-01'),
    }) as never)
    fsMock.unlink.mockRejectedValue({ busy: true })

    await expect(caller.deleteFile({ filename: 'b.RAW' })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to delete file: Unknown error',
    })
  })
})
