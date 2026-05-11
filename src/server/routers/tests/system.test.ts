/**
 * Tests for the system router — internetStatus, setInternetAccess (block/
 * unblock + lock + error wrap), wifiStatus parsing, triggerUpdate spawn,
 * getLogSources active flag, getLogs newest-first reversal + ENOENT fallback,
 * getDiskUsage parse + dev fallback, getStorageBreakdown nullable mounts,
 * getVersion git-info parse + fallback.
 *
 * child_process.execFile + spawn, fs/promises, and node:fs are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const execMock = vi.hoisted(() => ({
  execFile: vi.fn((..._args: unknown[]) => {
    const cb = _args[_args.length - 1] as (e: unknown, o: { stdout: string }) => void
    cb(null, { stdout: '' })
  }),
  spawn: vi.fn(() => ({
    on: vi.fn(),
    unref: vi.fn(),
  })),
}))

const fsPromisesMock = vi.hoisted(() => ({
  readdir: vi.fn(async () => []),
  readFile: vi.fn(async () => ''),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
}))

const fsSyncMock = vi.hoisted(() => ({
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}))

vi.mock('node:child_process', () => ({
  execFile: execMock.execFile,
  spawn: execMock.spawn,
  default: { execFile: execMock.execFile, spawn: execMock.spawn },
}))
vi.mock('node:fs/promises', () => ({ ...fsPromisesMock, default: fsPromisesMock }))
vi.mock('node:fs', () => ({ ...fsSyncMock, default: fsSyncMock }))

const { systemRouter } = await import('@/src/server/routers/system')
const caller = systemRouter.createCaller({})

beforeEach(() => {
  execMock.execFile.mockReset()
  execMock.execFile.mockImplementation((...args: unknown[]) => {
    const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
    cb(null, { stdout: '' })
  })
  execMock.spawn.mockReset().mockReturnValue({ on: vi.fn(), unref: vi.fn() } as never)
  fsPromisesMock.readdir.mockReset().mockResolvedValue([])
  fsPromisesMock.readFile.mockReset().mockResolvedValue('')
  fsPromisesMock.writeFile.mockReset().mockResolvedValue(undefined)
  fsPromisesMock.mkdir.mockReset().mockResolvedValue(undefined)
})

// Helper: queue execFile responses by command-name match
function queueExec(matcher: (file: string, args: string[]) => boolean, response: { stdout?: string, error?: Error }) {
  execMock.execFile.mockImplementationOnce((...allArgs: unknown[]) => {
    const file = allArgs[0] as string
    const args = (allArgs[1] as string[]) ?? []
    const cb = allArgs[allArgs.length - 1] as (e: unknown, o: { stdout: string }) => void
    if (matcher(file, args)) {
      if (response.error) cb(response.error, { stdout: '' })
      else cb(null, { stdout: response.stdout ?? '' })
    }
    else {
      cb(null, { stdout: '' })
    }
  })
}

describe('system.internetStatus', () => {
  it('returns blocked=true when iptables -L OUTPUT shows DROP', async () => {
    queueExec(
      (_file, args) => args.includes('-L') && args.includes('OUTPUT'),
      { stdout: 'DROP all -- 0.0.0.0/0\n' },
    )
    const result = await caller.internetStatus({})
    expect(result.blocked).toBe(true)
  })

  it('returns blocked=false on iptables error (dev environment)', async () => {
    queueExec(() => true, { error: new Error('iptables: command not found') })
    const result = await caller.internetStatus({})
    expect(result.blocked).toBe(false)
  })
})

describe('system.setInternetAccess', () => {
  it('unblocks WAN by flushing rules and re-checks state', async () => {
    // After unblock, isWanBlocked should return false (no DROP)
    const result = await caller.setInternetAccess({ blocked: false })
    expect(result.blocked).toBe(false)
  })

  it('wraps execFile failures as INTERNAL_SERVER_ERROR', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('iptables boom'), { stdout: '' })
    })
    await expect(caller.setInternetAccess({ blocked: false })).rejects.toThrow(/Failed to update iptables/)
  })
})

describe('system.wifiStatus', () => {
  it('returns connected=false when nmcli is unavailable', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('nmcli not found'), { stdout: '' })
    })
    const result = await caller.wifiStatus({})
    expect(result).toEqual({ connected: false, ssid: null, signal: null })
  })

  it('parses nmcli output and returns SSID + signal', async () => {
    queueExec(
      (file) => file === 'nmcli',
      { stdout: 'no:OtherNet:50\nyes:HomeWiFi:80\n' },
    )
    const result = await caller.wifiStatus({})
    expect(result.connected).toBe(true)
    expect(result.ssid).toBe('HomeWiFi')
    expect(result.signal).toBe(80)
  })

  it('handles escaped colons in SSID', async () => {
    queueExec(
      (file) => file === 'nmcli',
      { stdout: 'yes:My\\:Net:75\n' },
    )
    const result = await caller.wifiStatus({})
    expect(result.ssid).toBe('My:Net')
    expect(result.signal).toBe(75)
  })
})

describe('system.triggerUpdate', () => {
  it('spawns sp-update with the requested branch', async () => {
    const result = await caller.triggerUpdate({ branch: 'feature/cool' })
    expect(execMock.spawn).toHaveBeenCalledWith('sudo',
      ['-n', '/usr/local/bin/sp-update', 'feature/cool'],
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    )
    expect(result.triggered).toBe(true)
    expect(result.branch).toBe('feature/cool')
  })

  it('defaults branch to "main" when omitted', async () => {
    const result = await caller.triggerUpdate({})
    expect(result.branch).toBe('main')
    expect(execMock.spawn).toHaveBeenCalledWith('sudo',
      ['-n', '/usr/local/bin/sp-update', 'main'],
      expect.any(Object),
    )
  })

  it('rejects branch names with invalid characters', async () => {
    await expect(caller.triggerUpdate({ branch: 'evil; rm -rf /' })).rejects.toThrow(/Invalid branch name/)
  })
})

describe('system.getLogSources', () => {
  it('returns each unit with active=true when systemctl exits 0', async () => {
    // All systemctl is-active calls succeed by default
    const result = await caller.getLogSources({})
    expect(result.sources).toHaveLength(4)
    expect(result.sources.every(s => s.active)).toBe(true)
  })

  it('marks units inactive when systemctl errors', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('inactive'), { stdout: '' })
    })
    const result = await caller.getLogSources({})
    expect(result.sources.every(s => !s.active)).toBe(true)
  })
})

describe('system.getLogs', () => {
  it('returns dev-friendly fallback when journalctl is missing', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' })
      cb(err, { stdout: '' })
    })
    const result = await caller.getLogs({ unit: 'sleepypod.service', lines: 10 })
    expect(result.lines[0]).toContain('not available')
    expect(result.nextCursor).toBeNull()
  })

  it('reverses journalctl output to newest-first and exposes a cursor when more remain', async () => {
    queueExec(
      (file) => file === 'journalctl',
      // 3 lines + cursor when only 2 requested → hasMore=true
      { stdout: 'line1\nline2\nline3\n-- cursor: s=abc\n' },
    )
    const result = await caller.getLogs({ unit: 'sleepypod.service', lines: 2 })
    expect(result.lines).toEqual(['line3', 'line2'])
    expect(result.nextCursor).toBe('s=abc')
  })

  it('rejects unit names that do not match the sleepypod*.service pattern', async () => {
    await expect(caller.getLogs({ unit: 'evil.service', lines: 10 })).rejects.toThrow(/Invalid unit name/)
  })
})

describe('system.getDiskUsage', () => {
  it('parses df totals when available', async () => {
    queueExec(
      (file, args) => file === 'df' && args.includes('/'),
      { stdout: 'fs 1B-blocks Used Available Use% Mounted\n/dev 1000 200 800 20% /\n' },
    )
    const result = await caller.getDiskUsage({})
    expect(result.totalBytes).toBe(1000)
    expect(result.usedBytes).toBe(200)
    expect(result.availableBytes).toBe(800)
    expect(result.usedPercent).toBe(20)
  })

  it('returns zeros when df is unavailable', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('df not found'), { stdout: '' })
    })
    const result = await caller.getDiskUsage({})
    expect(result).toEqual({ totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0 })
  })
})

describe('system.getStorageBreakdown', () => {
  it('returns zero sections when df + du are unavailable', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('not found'), { stdout: '' })
    })
    fsPromisesMock.readdir.mockResolvedValue([])

    const result = await caller.getStorageBreakdown({})
    expect(result.emmc.totalBytes).toBe(0)
    expect(result.biometricsArchive).toEqual({ usedBytes: 0, fileCount: 0 })
  })
})

describe('system.getVersion', () => {
  it('parses .git-info when present', async () => {
    fsPromisesMock.readFile.mockResolvedValue(JSON.stringify({
      branch: 'main',
      commitHash: 'abc123',
      commitTitle: 'fix: thing',
      buildDate: '2026-04-01',
    }))
    const result = await caller.getVersion({})
    expect(result).toEqual({
      branch: 'main',
      commitHash: 'abc123',
      commitTitle: 'fix: thing',
      buildDate: '2026-04-01',
    })
  })

  it('returns "unknown" placeholders when .git-info is missing', async () => {
    fsPromisesMock.readFile.mockRejectedValue(new Error('ENOENT'))
    const result = await caller.getVersion({})
    expect(result).toEqual({
      branch: 'unknown', commitHash: 'unknown',
      commitTitle: 'unknown', buildDate: 'unknown',
    })
  })
})
