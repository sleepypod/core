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
  // Default: throw so resolveExec falls back to bare names (matches dev/macOS).
  // The fallback `return name` branch in resolveExec is exercised at module load.
  accessSync: vi.fn(() => { throw new Error('ENOENT') }),
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

interface ExecCall { file: string, args: string[], options: Record<string, unknown> | undefined }

/**
 * Records every execFile invocation (file + args + options) so tests can assert
 * the *exact* commands the router shells out — this is what kills the large
 * cluster of StringLiteral / ArrayDeclaration / ObjectLiteral mutants on the
 * df / du / iptables / journalctl / systemctl / nmcli calls. The `responder`
 * returns the stdout string for a given (file, args).
 *
 * promisify(execFile) calls the mock as (file, args, options, cb) when options
 * are passed, (file, args, cb) with args only, or (file, cb) with neither — so
 * options live at index 2 only when there are 4 positional arguments.
 */
function recordExec(responder: (file: string, args: string[]) => string = () => ''): ExecCall[] {
  const calls: ExecCall[] = []
  execMock.execFile.mockImplementation((...allArgs: unknown[]) => {
    const file = allArgs[0] as string
    const args = Array.isArray(allArgs[1]) ? (allArgs[1] as string[]) : []
    const options = allArgs.length === 4 ? (allArgs[2] as Record<string, unknown>) : undefined
    const cb = allArgs[allArgs.length - 1] as (e: unknown, o: { stdout: string }) => void
    calls.push({ file, args, options })
    cb(null, { stdout: responder(file, args) })
  })
  return calls
}

// Find the first recorded call to a given binary, asserting it happened.
function callTo(calls: ExecCall[], file: string): ExecCall {
  const c = calls.find(call => call.file === file)
  if (!c) throw new Error(`expected an execFile call to "${file}", saw: ${calls.map(x => x.file).join(', ')}`)
  return c
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
  it('unblocks WAN through the privileged helper and verifies the result', async () => {
    const calls = recordExec()
    const result = await caller.setInternetAccess({ blocked: false })

    expect(result.blocked).toBe(false)
    expect(callTo(calls, 'sudo')).toEqual({
      file: 'sudo',
      args: ['-n', '/usr/local/bin/sp-update', '--internet-access', 'unblock'],
      options: { timeout: 30_000 },
    })
  })

  it('blocks WAN through the privileged helper and verifies the result', async () => {
    const calls = recordExec((file, args) => {
      if (file === 'iptables' && args.includes('-L')) return 'DROP all -- 0.0.0.0/0\n'
      return ''
    })

    const result = await caller.setInternetAccess({ blocked: true })

    expect(result.blocked).toBe(true)
    expect(callTo(calls, 'sudo')).toEqual({
      file: 'sudo',
      args: ['-n', '/usr/local/bin/sp-update', '--internet-access', 'block'],
      options: { timeout: 30_000 },
    })
  })

  it('rejects a successful helper exit when the requested state was not applied', async () => {
    recordExec()

    await expect(caller.setInternetAccess({ blocked: true }))
      .rejects.toThrow(/helper completed but WAN is open/)
  })

  it('serializes concurrent firewall transitions', async () => {
    let firstHelperCallback: ((error: unknown, output: { stdout: string }) => void) | undefined
    let helperCalls = 0
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string
      const cb = args[args.length - 1] as (error: unknown, output: { stdout: string }) => void
      if (file === 'sudo') {
        helperCalls++
        if (helperCalls === 1) {
          firstHelperCallback = cb
          return
        }
      }
      cb(null, { stdout: '' })
    })

    const first = caller.setInternetAccess({ blocked: false })
    await vi.waitFor(() => expect(helperCalls).toBe(1))
    const second = caller.setInternetAccess({ blocked: false })
    await Promise.resolve()

    expect(helperCalls).toBe(1)
    firstHelperCallback?.(null, { stdout: '' })
    await expect(first).resolves.toEqual({ blocked: false })
    await expect(second).resolves.toEqual({ blocked: false })
    expect(helperCalls).toBe(2)
  })

  it('wraps helper failures as INTERNAL_SERVER_ERROR', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('firewall helper failed'), { stdout: '' })
    })
    await expect(caller.setInternetAccess({ blocked: false })).rejects.toThrow(/Failed to update iptables/)
  })

  it('wraps non-Error throws with an "Unknown error" message', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      // Reject with a non-Error value to hit the `'Unknown error'` branch
      cb('weird string failure', { stdout: '' })
    })
    await expect(caller.setInternetAccess({ blocked: false })).rejects.toThrow(/Unknown error/)
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
      file => file === 'nmcli',
      { stdout: 'no:OtherNet:50\nyes:HomeWiFi:80\n' },
    )
    const result = await caller.wifiStatus({})
    expect(result.connected).toBe(true)
    expect(result.ssid).toBe('HomeWiFi')
    expect(result.signal).toBe(80)
  })

  it('trims leading whitespace before finding the active nmcli row', async () => {
    queueExec(file => file === 'nmcli', { stdout: '   yes:HomeWiFi:80\n' })
    await expect(caller.wifiStatus({})).resolves.toEqual({
      connected: true,
      ssid: 'HomeWiFi',
      signal: 80,
    })
  })

  it('handles escaped colons in SSID', async () => {
    queueExec(
      file => file === 'nmcli',
      { stdout: 'yes:My\\:Net:75\n' },
    )
    const result = await caller.wifiStatus({})
    expect(result.ssid).toBe('My:Net')
    expect(result.signal).toBe(75)
  })

  it('returns connected=false when no active WiFi line is present', async () => {
    queueExec(
      file => file === 'nmcli',
      { stdout: 'no:OtherNet:50\nno:Cafe:30\n' },
    )
    const result = await caller.wifiStatus({})
    expect(result).toEqual({ connected: false, ssid: null, signal: null })
  })

  it('returns null signal when nmcli signal field is non-numeric', async () => {
    queueExec(
      file => file === 'nmcli',
      { stdout: 'yes:Home:NaN\n' },
    )
    const result = await caller.wifiStatus({})
    expect(result.connected).toBe(true)
    expect(result.ssid).toBe('Home')
    expect(result.signal).toBeNull()
  })

  it('keeps a trailing literal backslash in an SSID field', async () => {
    queueExec(file => file === 'nmcli', { stdout: 'yes:Home\\\\:77\n' })
    const result = await caller.wifiStatus({})
    expect(result).toEqual({ connected: true, ssid: 'Home\\', signal: 77 })
  })

  it('keeps an unescaped backslash at the absolute end of the active row', async () => {
    queueExec(file => file === 'nmcli', { stdout: 'yes:Trailing\\' })
    await expect(caller.wifiStatus({})).resolves.toEqual({
      connected: true,
      ssid: 'Trailing\\',
      signal: null,
    })
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
    expect(result.message).toMatch(/Update started/)
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

  it('rejects git-ref-unsafe branch names the character class allows', async () => {
    for (const branch of ['../etc', 'a//b', '/leading', 'trailing/', '-rf', 'x.lock']) {
      await expect(caller.triggerUpdate({ branch })).rejects.toThrow(/Invalid branch name/)
    }
  })

  it('accepts a normal nested feature branch', async () => {
    const result = await caller.triggerUpdate({ branch: 'feat/pump-2.0_fix' })
    expect(result.triggered).toBe(true)
  })

  it('registers an error listener on the child to swallow spawn failures', async () => {
    const onSpy = vi.fn()
    const unrefSpy = vi.fn()
    execMock.spawn.mockReturnValueOnce({ on: onSpy, unref: unrefSpy } as never)
    await caller.triggerUpdate({})
    expect(onSpy).toHaveBeenCalledWith('error', expect.any(Function))
    expect(unrefSpy).toHaveBeenCalled()
    // Invoke the registered error handler — must not throw (only logs).
    const handler = onSpy.mock.calls.find(c => c[0] === 'error')?.[1] as (e: Error) => void
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bootErr = new Error('ENOENT')
    expect(() => handler(bootErr)).not.toThrow()
    expect(errSpy).toHaveBeenCalledWith('[system.triggerUpdate] sp-update spawn failed:', bootErr)
    errSpy.mockRestore()
  })

  it('wraps synchronous spawn failures as INTERNAL_SERVER_ERROR', async () => {
    execMock.spawn.mockImplementationOnce(() => {
      throw new Error('spawn EACCES')
    })
    await expect(caller.triggerUpdate({})).rejects.toThrow(/Failed to trigger update/)
  })

  it('wraps non-Error spawn throws with "Unknown error"', async () => {
    execMock.spawn.mockImplementationOnce(() => {
      throw 'string failure'
    })
    await expect(caller.triggerUpdate({})).rejects.toThrow(/Unknown error/)
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
      file => file === 'journalctl',
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

  it('passes --until-cursor, --since, and -p when those inputs are set', async () => {
    let capturedArgs: string[] = []
    execMock.execFile.mockImplementationOnce((...args: unknown[]) => {
      capturedArgs = (args[1] as string[]) ?? []
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(null, { stdout: 'l1\n-- cursor: s=xyz\n' })
    })
    const result = await caller.getLogs({
      unit: 'sleepypod.service',
      lines: 5,
      cursor: 's=prev',
      since: '1 hour ago',
      priority: 'err',
    })
    expect(capturedArgs).toContain('--until-cursor')
    expect(capturedArgs).toContain('s=prev')
    expect(capturedArgs).toContain('--since')
    expect(capturedArgs).toContain('1 hour ago')
    expect(capturedArgs).toContain('-p')
    expect(capturedArgs).toContain('err')
    // With only one log line and lines=5 → hasMore=false, nextCursor=null
    expect(result.nextCursor).toBeNull()
    expect(result.lines).toEqual(['l1'])
  })

  it('returns a truncation message when journalctl exceeds maxBuffer', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      const err = Object.assign(new Error('maxBuffer exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      cb(err, { stdout: '' })
    })
    const result = await caller.getLogs({ unit: 'sleepypod.service', lines: 10 })
    expect(result.lines[0]).toMatch(/too large/i)
    expect(result.nextCursor).toBeNull()
  })

  it('wraps unexpected journalctl failures as INTERNAL_SERVER_ERROR', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb(new Error('permission denied'), { stdout: '' })
    })
    await expect(
      caller.getLogs({ unit: 'sleepypod.service', lines: 10 }),
    ).rejects.toThrow(/Failed to read logs/)
  })

  it('labels a non-Error journalctl failure as "Unknown error"', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      cb('weird non-error failure', { stdout: '' })
    })
    await expect(
      caller.getLogs({ unit: 'sleepypod.service', lines: 10 }),
    ).rejects.toThrow(/Unknown error/)
  })

  it('returns nextCursor=null when journalctl omits the cursor line but more entries exist', async () => {
    queueExec(
      file => file === 'journalctl',
      // 3 lines + no cursor line, with lines=2 → hasMore=true but parsing failed
      { stdout: 'line1\nline2\nline3\n' },
    )
    const result = await caller.getLogs({ unit: 'sleepypod.service', lines: 2 })
    expect(result.lines).toHaveLength(2)
    expect(result.nextCursor).toBeNull()
  })

  it('normalizes an empty journal cursor to null when more entries exist', async () => {
    queueExec(file => file === 'journalctl', {
      stdout: 'line1\nline2\nline3\n-- cursor:    \n',
    })
    await expect(caller.getLogs({ unit: 'sleepypod.service', lines: 2 })).resolves.toEqual({
      lines: ['line3', 'line2'],
      nextCursor: null,
    })
  })

  it('trims cursor padding and discards whitespace-only log lines', async () => {
    queueExec(file => file === 'journalctl', {
      stdout: 'line1\nline2\n   \nline3\n-- cursor: s=padded   \n',
    })
    const result = await caller.getLogs({ unit: 'sleepypod.service', lines: 2 })
    expect(result).toEqual({ lines: ['line3', 'line2'], nextCursor: 's=padded' })
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

  it('parses df + du output for each mount and counts archive files', async () => {
    execMock.execFile.mockImplementation((...args: unknown[]) => {
      const file = args[0] as string
      const argList = (args[1] as string[]) ?? []
      const cb = args[args.length - 1] as (e: unknown, o: { stdout: string }) => void
      if (file === 'df' && argList.includes('/persistent') && !argList.includes('/persistent/biometrics')) {
        cb(null, { stdout: 'fs 1B-blocks Used Available Use% Mounted\n/dev/mmcblk0 2000 500 1500 25% /persistent\n' })
        return
      }
      if (file === 'df' && argList.includes('/persistent/biometrics')) {
        cb(null, { stdout: 'fs 1B-blocks Used Available Use% Mounted\ntmpfs 100 40 60 40% /persistent/biometrics\n' })
        return
      }
      if (file === 'du') {
        cb(null, { stdout: '1234\t/persistent/biometrics-archive\n' })
        return
      }
      cb(null, { stdout: '' })
    })
    // 3 entries: 2 files + 1 dir → fileCount=2
    fsPromisesMock.readdir.mockResolvedValueOnce([
      { isFile: () => true } as never,
      { isFile: () => true } as never,
      { isFile: () => false } as never,
    ])

    const result = await caller.getStorageBreakdown({})
    expect(result.emmc).toEqual({
      totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25,
    })
    expect(result.biometricsTmpfs).toEqual({
      totalBytes: 100, usedBytes: 40, availableBytes: 60, usedPercent: 40,
    })
    expect(result.biometricsArchive).toEqual({ usedBytes: 1234, fileCount: 2 })
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

  it('substitutes "unknown" for individual non-string fields in .git-info', async () => {
    // Each field of the parsed JSON is non-string → each branch falls back
    fsPromisesMock.readFile.mockResolvedValue(JSON.stringify({
      branch: 42,
      commitHash: null,
      commitTitle: { not: 'a string' },
      buildDate: ['array'],
    }))
    const result = await caller.getVersion({})
    expect(result).toEqual({
      branch: 'unknown', commitHash: 'unknown',
      commitTitle: 'unknown', buildDate: 'unknown',
    })
  })

  it('reads the build manifest from ".git-info" as utf-8', async () => {
    fsPromisesMock.readFile.mockResolvedValueOnce('{}')
    await caller.getVersion({})
    expect(fsPromisesMock.readFile).toHaveBeenCalledWith('.git-info', 'utf-8')
  })
})

// ---------------------------------------------------------------------------
// Exact-command assertions.
//
// The behavioural tests above pin *what comes back*; the blocks below pin
// *what gets executed* — the literal binary names, argument vectors, and
// option objects. These exist to kill the StringLiteral / ArrayDeclaration /
// ObjectLiteral / Regex / arithmetic mutants that survive when only outputs
// are checked (see the mutation-testing baseline, issue #591).
// ---------------------------------------------------------------------------

describe('system.internetStatus — command + DROP-rule matching', () => {
  it('inspects the OUTPUT chain via `iptables -L OUTPUT -n`', async () => {
    const calls = recordExec(() => '')
    await caller.internetStatus({})
    expect(callTo(calls, 'iptables').args).toEqual(['-L', 'OUTPUT', '-n'])
  })

  it('treats only a line that STARTS with DROP as blocked (anchored ^)', async () => {
    // A DROP appearing mid-line (e.g. a reject target) must NOT count.
    recordExec(() => 'ACCEPT all -- 0.0.0.0/0 reject-with DROP\n')
    const result = await caller.internetStatus({})
    expect(result.blocked).toBe(false)
  })

  it('requires a word boundary after DROP (DROPLET is not a DROP rule)', async () => {
    recordExec(() => 'DROPLET all -- 0.0.0.0/0\n')
    const result = await caller.internetStatus({})
    expect(result.blocked).toBe(false)
  })
})

describe('system.setInternetAccess — helper ordering', () => {
  it('runs the unblock helper before checking the resulting firewall state', async () => {
    const calls = recordExec()
    await caller.setInternetAccess({ blocked: false })

    expect(calls.map(({ file, args, options }) => ({ file, args, options }))).toEqual([
      {
        file: 'sudo',
        args: ['-n', '/usr/local/bin/sp-update', '--internet-access', 'unblock'],
        options: { timeout: 30_000 },
      },
      { file: 'iptables', args: ['-L', 'OUTPUT', '-n'], options: undefined },
    ])
  })

  it('runs the block helper before checking the resulting firewall state', async () => {
    const calls = recordExec((file, args) => {
      if (file === 'iptables' && args.includes('-L') && args.includes('OUTPUT')) return 'DROP all -- 0.0.0.0/0\n'
      return ''
    })

    const result = await caller.setInternetAccess({ blocked: true })
    expect(result.blocked).toBe(true)
    expect(calls.map(({ file, args, options }) => ({ file, args, options }))).toEqual([
      {
        file: 'sudo',
        args: ['-n', '/usr/local/bin/sp-update', '--internet-access', 'block'],
        options: { timeout: 30_000 },
      },
      { file: 'iptables', args: ['-L', 'OUTPUT', '-n'], options: undefined },
    ])
  })
})

describe('system.wifiStatus — exact command', () => {
  it('queries nmcli in terse mode for ACTIVE,SSID,SIGNAL', async () => {
    const calls = recordExec(() => 'yes:Home:80\n')
    await caller.wifiStatus({})
    expect(callTo(calls, 'nmcli').args).toEqual(['-t', '-f', 'ACTIVE,SSID,SIGNAL', 'dev', 'wifi'])
  })
})

describe('system.getLogSources — exact command', () => {
  it('runs `systemctl is-active --quiet <unit>` for every tracked unit', async () => {
    const calls = recordExec(() => '')
    await caller.getLogSources({})
    const units = calls.filter(c => c.file === 'systemctl').map(c => c.args)
    expect(units).toContainEqual(['is-active', '--quiet', 'sleepypod.service'])
    expect(units).toContainEqual(['is-active', '--quiet', 'sleepypod-piezo-processor.service'])
    expect(units).toContainEqual(['is-active', '--quiet', 'sleepypod-sleep-detector.service'])
    expect(units).toContainEqual(['is-active', '--quiet', 'sleepypod-environment-monitor.service'])
    expect(units).toHaveLength(4)
  })

  it('pairs each unit with its human-readable name', async () => {
    recordExec(() => '')
    const result = await caller.getLogSources({})
    // Pins the display-name string literals, not just the unit ids.
    expect(result.sources).toEqual([
      { unit: 'sleepypod.service', name: 'Core', active: true },
      { unit: 'sleepypod-piezo-processor.service', name: 'Piezo Processor', active: true },
      { unit: 'sleepypod-sleep-detector.service', name: 'Sleep Detector', active: true },
      { unit: 'sleepypod-environment-monitor.service', name: 'Environment Monitor', active: true },
    ])
  })
})

describe('system.getLogs — exact command + options', () => {
  it('builds the journalctl base args, fetches lines+1, and sets timeout/maxBuffer', async () => {
    const calls = recordExec(() => 'a\n-- cursor: s=z\n')
    await caller.getLogs({ unit: 'sleepypod.service', lines: 100 })
    const c = callTo(calls, 'journalctl')
    // lines + 1 = 101 (the extra line is how "hasMore" is detected).
    expect(c.args).toEqual([
      '-u', 'sleepypod.service',
      '-n', '101',
      '--no-pager',
      '--output', 'short-iso',
      '--show-cursor',
    ])
    expect(c.options).toEqual({ timeout: 10000, maxBuffer: 5 * 1024 * 1024 })
  })

  it('does NOT paginate when the line count exactly equals the requested limit', async () => {
    // Exactly `lines` entries (+ cursor) → hasMore must be false. A `>=`
    // mutant on the `logLines.length > input.lines` check would wrongly
    // page here and surface a cursor.
    queueExec(
      file => file === 'journalctl',
      { stdout: 'line1\nline2\n-- cursor: s=abc\n' },
    )
    const result = await caller.getLogs({ unit: 'sleepypod.service', lines: 2 })
    expect(result.lines).toEqual(['line2', 'line1'])
    expect(result.nextCursor).toBeNull()
  })
})

describe('system.getDiskUsage — exact command + whitespace/percent edges', () => {
  it('invokes `df -B1 /` with a 5000ms timeout', async () => {
    const calls = recordExec(file => (file === 'df'
      ? 'Filesystem 1B-blocks Used Available Use% Mounted on\n/dev/root 1000 200 800 20% /\n'
      : ''))
    await caller.getDiskUsage({})
    const c = callTo(calls, 'df')
    expect(c.args).toEqual(['-B1', '/'])
    expect(c.options).toEqual({ timeout: 5000 })
  })

  it('splits columns on RUNS of whitespace, not single chars', async () => {
    // Real df pads columns with multiple spaces. A /\s/ (non-greedy) mutant
    // would yield empty fields and mis-parse every number.
    recordExec(() => 'Filesystem     1B-blocks      Used  Available Use% Mounted\n/dev/root      1000       200        800  20% /\n')
    const result = await caller.getDiskUsage({})
    expect(result.totalBytes).toBe(1000)
    expect(result.usedBytes).toBe(200)
    expect(result.availableBytes).toBe(800)
    expect(result.usedPercent).toBe(20)
  })

  it('trims leading blank lines before selecting the df data row', async () => {
    recordExec(() => '\nFilesystem 1B-blocks Used Available Use% Mounted\n/dev/root 900 300 600 33% /\n')
    await expect(caller.getDiskUsage({})).resolves.toEqual({
      totalBytes: 900,
      usedBytes: 300,
      availableBytes: 600,
      usedPercent: 33.33,
    })
  })

  it('returns usedPercent=0 (not Infinity) when totalBytes is 0', async () => {
    // Guards the `totalBytes > 0 ? … : 0` branch: a `>= 0`/`true` mutant would
    // divide by zero and surface Infinity.
    recordExec(() => 'Filesystem 1B-blocks Used Available Use% Mounted\noverlay 0 5 0 0% /\n')
    const result = await caller.getDiskUsage({})
    expect(result.totalBytes).toBe(0)
    expect(result.usedPercent).toBe(0)
  })
})

describe('system.getStorageBreakdown — exact commands', () => {
  it('queries df per-mount and du for the archive, each with a 5000ms timeout', async () => {
    const calls = recordExec((file, args) => {
      if (file === 'df' && args.includes('/persistent') && !args.includes('/persistent/biometrics'))
        return 'Filesystem 1B-blocks Used Available Use% Mounted\n/dev/mmcblk0   2000   500   1500 25% /persistent\n'
      if (file === 'df' && args.includes('/persistent/biometrics'))
        return 'Filesystem 1B-blocks Used Available Use% Mounted\ntmpfs   100   40   60 40% /persistent/biometrics\n'
      if (file === 'du') return '1234\t/persistent/biometrics-archive\n'
      return ''
    })
    fsPromisesMock.readdir.mockResolvedValueOnce([{ isFile: () => true } as never])

    const result = await caller.getStorageBreakdown({})

    const dfArgs = calls.filter(c => c.file === 'df').map(c => c.args)
    expect(dfArgs).toContainEqual(['-B1', '/persistent'])
    expect(dfArgs).toContainEqual(['-B1', '/persistent/biometrics'])
    for (const c of calls.filter(c => c.file === 'df')) expect(c.options).toEqual({ timeout: 5000 })

    const du = callTo(calls, 'du')
    expect(du.args).toEqual(['-sb', '/persistent/biometrics-archive'])
    expect(du.options).toEqual({ timeout: 5000 })

    // Assert the parsed values too — the multi-space fixture means a /\s/
    // (single-char) regex mutant in dfBreakdown would mis-parse the columns.
    expect(result.emmc).toEqual({ totalBytes: 2000, usedBytes: 500, availableBytes: 1500, usedPercent: 25 })
    expect(result.biometricsTmpfs).toEqual({ totalBytes: 100, usedBytes: 40, availableBytes: 60, usedPercent: 40 })
    expect(result.biometricsArchive).toEqual({ usedBytes: 1234, fileCount: 1 })
  })

  it('reports usedPercent=0 (not Infinity) for a mount that reports 0 total blocks', async () => {
    recordExec((file, args) => {
      if (file === 'df' && args.includes('/persistent') && !args.includes('/persistent/biometrics'))
        return 'Filesystem 1B-blocks Used Available Use% Mounted\noverlay   0   5   0 0% /persistent\n'
      return ''
    })
    fsPromisesMock.readdir.mockResolvedValueOnce([])
    const result = await caller.getStorageBreakdown({})
    expect(result.emmc.totalBytes).toBe(0)
    expect(result.emmc.usedPercent).toBe(0)
  })

  it('trims leading df/du whitespace in the storage helpers', async () => {
    recordExec((file, args) => {
      if (file === 'df' && args.includes('/persistent') && !args.includes('/persistent/biometrics'))
        return '\nFilesystem 1B-blocks Used Available Use% Mounted\n/dev/root 500 125 375 25% /persistent\n'
      if (file === 'df')
        return '\nFilesystem 1B-blocks Used Available Use% Mounted\ntmpfs 200 50 150 25% /persistent/biometrics\n'
      if (file === 'du') return '\n  4321   /persistent/biometrics-archive\n'
      return ''
    })
    fsPromisesMock.readdir.mockResolvedValueOnce([{ isFile: () => true } as never])

    await expect(caller.getStorageBreakdown({})).resolves.toEqual({
      emmc: { totalBytes: 500, usedBytes: 125, availableBytes: 375, usedPercent: 25 },
      biometricsTmpfs: { totalBytes: 200, usedBytes: 50, availableBytes: 150, usedPercent: 25 },
      biometricsArchive: { usedBytes: 4321, fileCount: 1 },
    })
  })
})
