/**
 * Tests for the GET handler in app/api/export/archive/route.ts. Covers the
 * inflight guard, the staging-dir setup, conditional db backup, raw symlink
 * staging, the tar spawn / streaming response shape, and the catch-all error
 * path. fs/promises, child_process.spawn, and better-sqlite3 are mocked so
 * the test stays hermetic — no real shelling out, no real DB.
 *
 * gatherRawFiles is exercised separately in route.test.ts (real fs); we mock
 * readdir here so the GET path's call to it returns deterministic file lists.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  mkdtemp: vi.fn<(prefix: string) => Promise<string>>(async prefix => `${prefix}abc123`),
  readdir: vi.fn<(dir: unknown) => Promise<string[]>>(async () => []),
  rm: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  stat: vi.fn<(p: unknown) => Promise<{ mtime: Date }>>(async () => ({ mtime: new Date(1_000_000) })),
  symlink: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}))

vi.mock('node:fs/promises', () => ({ ...fsMock, default: fsMock }))

interface FakeChild extends EventEmitter {
  stdout: Readable
  stderr: EventEmitter
  kill: ReturnType<typeof vi.fn>
}

const spawnMock = vi.hoisted(() => ({
  spawn: vi.fn(),
  lastChild: null as FakeChild | null,
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock.spawn,
  default: { spawn: spawnMock.spawn },
}))

const sqliteMock = vi.hoisted(() => ({
  backup: vi.fn(async () => undefined),
  close: vi.fn(),
  ctor: vi.fn(),
}))

vi.mock('better-sqlite3', () => {
  const Database = vi.fn(function (this: Record<string, unknown>, ...args: unknown[]) {
    sqliteMock.ctor(...args)
    this.backup = sqliteMock.backup
    this.close = sqliteMock.close
  })
  return { default: Database }
})

function makeFakeChild(): FakeChild {
  const stdout = Readable.from(Buffer.from('tar-bytes'))
  const stderr = new EventEmitter()
  const child = new EventEmitter() as FakeChild
  child.stdout = stdout
  child.stderr = stderr
  child.kill = vi.fn()
  return child
}

beforeEach(() => {
  vi.clearAllMocks()
  fsMock.mkdir.mockImplementation(async () => undefined)
  fsMock.mkdtemp.mockImplementation(async prefix => `${prefix}abc123`)
  fsMock.readdir.mockImplementation(async () => [])
  fsMock.rm.mockImplementation(async () => undefined)
  fsMock.stat.mockImplementation(async () => ({ mtime: new Date(1_000_000) }))
  fsMock.symlink.mockImplementation(async () => undefined)
  sqliteMock.backup.mockImplementation(async () => undefined)
  spawnMock.spawn.mockImplementation(() => {
    const child = makeFakeChild()
    spawnMock.lastChild = child
    return child as never
  })
})

// Import after mocks are registered. Re-import per test resets the
// module-level `inflight` flag.
async function loadRoute() {
  vi.resetModules()
  return await import('./route')
}

describe('GET /api/export/archive', () => {
  it('returns a gzip stream response with default params (raw + db)', async () => {
    process.env.BIOMETRICS_DATABASE_URL = 'file:/tmp/biometrics.db'
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive')
    const res = await GET(req)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/gzip')
    expect(res.headers.get('Content-Disposition')).toMatch(
      /attachment; filename="sleepypod-export-0-\d+\.tar\.gz"/,
    )

    expect(fsMock.mkdir).toHaveBeenCalled() // staging dir
    expect(fsMock.mkdtemp).toHaveBeenCalled()
    expect(sqliteMock.backup).toHaveBeenCalledTimes(1) // db included by default
    expect(sqliteMock.close).toHaveBeenCalledTimes(1)
    expect(spawnMock.spawn).toHaveBeenCalledWith(
      'tar',
      expect.arrayContaining(['-czhf', '-']),
    )
    delete process.env.BIOMETRICS_DATABASE_URL
  })

  it('responds 429 when another export is already inflight', async () => {
    const { GET } = await loadRoute()
    // First call leaves `inflight = true` until tar closes; don't fire close.
    const req1 = new Request('http://localhost/api/export/archive')
    await GET(req1)

    const req2 = new Request('http://localhost/api/export/archive')
    const res = await GET(req2)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    const body = await res.json()
    expect(body).toEqual({ error: 'Another export is in progress, retry later' })
  })

  it('skips db backup when include omits db', async () => {
    process.env.BIOMETRICS_DATABASE_URL = 'file:/tmp/biometrics.db'
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=raw&startTs=0&endTs=10')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(sqliteMock.backup).not.toHaveBeenCalled()
    delete process.env.BIOMETRICS_DATABASE_URL
  })

  it('skips db backup when BIOMETRICS_DATABASE_URL is empty even if include=db', async () => {
    delete process.env.BIOMETRICS_DATABASE_URL
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=db')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(sqliteMock.backup).not.toHaveBeenCalled()
  })

  it('skips raw staging when include omits raw', async () => {
    process.env.BIOMETRICS_DATABASE_URL = 'file:/tmp/biometrics.db'
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=db')
    const res = await GET(req)
    expect(res.status).toBe(200)
    // mkdir for staging root is called, but the raw subdir mkdir is not
    // — fewer mkdir calls than the default path.
    expect(fsMock.symlink).not.toHaveBeenCalled()
    delete process.env.BIOMETRICS_DATABASE_URL
  })

  it('symlinks matched RAW files into the raw staging subdir', async () => {
    fsMock.readdir.mockImplementation(async (dir) => {
      // First source (tmpfs) yields one .RAW; others empty.
      if (String(dir).endsWith('/biometrics')) return ['00001.RAW']
      return []
    })
    fsMock.stat.mockImplementation(async () => ({ mtime: new Date(5000 * 1000) }))

    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=raw&startTs=0&endTs=10000')
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(fsMock.symlink).toHaveBeenCalledTimes(1)
    const call = fsMock.symlink.mock.calls[0]
    expect(String(call[0])).toContain('00001.RAW')
    expect(String(call[1])).toContain('/raw/')
  })

  it('swallows symlink failures (duplicate / unreadable entries)', async () => {
    fsMock.readdir.mockImplementation(async () => ['00001.RAW'])
    fsMock.stat.mockImplementation(async () => ({ mtime: new Date(5000 * 1000) }))
    fsMock.symlink.mockRejectedValueOnce(new Error('EEXIST'))

    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=raw&startTs=0&endTs=10000')
    const res = await GET(req)
    expect(res.status).toBe(200) // failure is swallowed
  })

  it('returns 500 when staging-dir creation fails and cleans up inflight', async () => {
    fsMock.mkdir.mockRejectedValueOnce(new Error('disk full'))

    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive')
    const res = await GET(req)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'disk full' })

    // After failure, inflight is reset so a follow-up call doesn't 429.
    const res2 = await GET(new Request('http://localhost/api/export/archive'))
    expect(res2.status).not.toBe(429)
  })

  it('returns 500 with default message when caught error is not an Error', async () => {
    fsMock.mkdir.mockImplementationOnce(() => {
      throw 'string-not-error'
    })

    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive')
    const res = await GET(req)
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Export failed' })
  })

  it('cleans up staging dir when mkdtemp succeeded but later step fails', async () => {
    // mkdir for EXPORT_STAGING_DIR succeeds; mkdtemp succeeds; then the raw
    // subdir mkdir throws — the catch handler should `rm` the staging dir.
    fsMock.mkdir
      .mockImplementationOnce(async () => undefined) // staging root
      .mockImplementationOnce(async () => { throw new Error('boom') }) // raw subdir

    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=raw')
    const res = await GET(req)
    expect(res.status).toBe(500)
    expect(fsMock.rm).toHaveBeenCalledWith(
      expect.stringContaining('sp-export-'),
      { recursive: true, force: true },
    )
  })

  it('logs tar stderr and clears inflight when tar exits non-zero', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=raw')
    const res = await GET(req)
    expect(res.status).toBe(200)

    const child = spawnMock.lastChild
    if (!child) throw new Error('expected spawn to have been called')
    child.stderr.emit('data', Buffer.from('tar: bad file'))
    child.emit('close', 2)

    expect(errSpy).toHaveBeenCalledWith('tar:', expect.stringContaining('tar: bad file'))
    // Now inflight should be cleared — follow-up call must not 429.
    const res2 = await GET(new Request('http://localhost/api/export/archive?include=raw'))
    expect(res2.status).not.toBe(429)
    errSpy.mockRestore()
  })

  it('clears inflight on tar spawn error event', async () => {
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?include=raw')
    const res = await GET(req)
    expect(res.status).toBe(200)

    const child = spawnMock.lastChild
    if (!child) throw new Error('expected spawn to have been called')
    child.emit('error', new Error('ENOENT: tar not found'))

    const res2 = await GET(new Request('http://localhost/api/export/archive?include=raw'))
    expect(res2.status).not.toBe(429)
  })

  it('rejects non-numeric startTs/endTs with 400 without latching inflight', async () => {
    const { GET } = await loadRoute()
    const res = await GET(new Request('http://localhost/api/export/archive?startTs=garbage'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body).toEqual({ error: 'startTs and endTs must be numeric epoch seconds' })
    expect(spawnMock.spawn).not.toHaveBeenCalled()

    // inflight must not have been taken by the rejected request.
    const res2 = await GET(new Request('http://localhost/api/export/archive?include=raw'))
    expect(res2.status).toBe(200)
  })

  it('kills tar, clears inflight, and removes staging when the client disconnects', async () => {
    const { GET } = await loadRoute()
    const controller = new AbortController()
    const req = new Request('http://localhost/api/export/archive?include=raw', {
      signal: controller.signal,
    })
    const res = await GET(req)
    expect(res.status).toBe(200)

    const child = spawnMock.lastChild
    if (!child) throw new Error('expected spawn to have been called')

    controller.abort()

    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(fsMock.rm).toHaveBeenCalledWith(
      expect.stringContaining('sp-export-'),
      { recursive: true, force: true },
    )
    // inflight cleared — a follow-up export is allowed.
    const res2 = await GET(new Request('http://localhost/api/export/archive?include=raw'))
    expect(res2.status).not.toBe(429)
  })

  it('kills tar and clears inflight when the watchdog expires', async () => {
    process.env.EXPORT_WATCHDOG_MS = '30'
    try {
      const { GET } = await loadRoute()
      const res = await GET(new Request('http://localhost/api/export/archive?include=raw'))
      expect(res.status).toBe(200)

      const child = spawnMock.lastChild
      if (!child) throw new Error('expected spawn to have been called')

      // tar never emits close/error — the watchdog must fire.
      await new Promise(r => setTimeout(r, 80))
      expect(child.kill).toHaveBeenCalledWith('SIGKILL')

      const res2 = await GET(new Request('http://localhost/api/export/archive?include=raw'))
      expect(res2.status).not.toBe(429)
    }
    finally {
      delete process.env.EXPORT_WATCHDOG_MS
    }
  })

  it('uses the provided startTs and endTs in the filename', async () => {
    const { GET } = await loadRoute()
    const req = new Request('http://localhost/api/export/archive?startTs=100&endTs=200&include=raw')
    const res = await GET(req)
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="sleepypod-export-100-200.tar.gz"',
    )
  })
})
