/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for iptables rule validation.
 * The module shells out via execSync; we mock node:child_process and
 * drive both branches (rules present, rules missing, repair, persist).
 */

vi.mock('node:child_process', () => {
  const execSync = vi.fn()
  return { execSync, default: { execSync } }
})

import { execSync as mockedExecSync } from 'node:child_process'

const execSyncMock = mockedExecSync as unknown as ReturnType<typeof vi.fn>

interface ExecHandlerArgs {
  cmd: string
  options?: { encoding?: string, timeout?: number }
}

type ExecHandler = (args: ExecHandlerArgs) => string | Buffer | undefined

function setExecHandler(handler: ExecHandler): void {
  execSyncMock.mockImplementation((cmd: string, options?: any) => {
    const result = handler({ cmd, options })
    return result == null ? '' : result
  })
}

function unavailableError(message: string, status?: number): Error {
  const err = new Error(message) as Error & { status?: number }
  if (status !== undefined) err.status = status
  return err
}

describe('iptablesCheck — module surface', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
    // Default: every call throws ENOENT-style — module assumes rules present.
    execSyncMock.mockImplementation(() => {
      throw unavailableError('iptables: command not found', 127)
    })
  })

  it('exports checkIptables and checkAndRepairIptables', async () => {
    const mod = await import('../iptablesCheck')
    expect(typeof mod.checkIptables).toBe('function')
    expect(typeof mod.checkAndRepairIptables).toBe('function')
  })

  it('checkIptables returns ok=true when iptables is unavailable', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.rules.length).toBe(5)
  })

  it('validates all critical rules are defined', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    const ruleNames = result.rules.map(r => r.name)
    expect(ruleNames).toContain('mDNS outbound (UDP 5353)')
    expect(ruleNames).toContain('mDNS inbound (UDP 5353)')
    expect(ruleNames).toContain('mDNS outbound source (UDP 5353)')
    expect(ruleNames).toContain('LAN access (192.168.0.0/16)')
    expect(ruleNames).toContain('NTP outbound (UDP 123)')
  })

  it('all rules are marked critical', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.rules.every(r => r.critical)).toBe(true)
  })

  it('rules cover both INPUT and OUTPUT chains', async () => {
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    const chains = new Set(result.rules.map(r => r.chain))
    expect(chains.has('INPUT')).toBe(true)
    expect(chains.has('OUTPUT')).toBe(true)
  })
})

describe('iptablesCheck — resolveIptablesPath', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  it('uses an explicit override path without invoking which', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) {
        throw new Error('which should not have been called')
      }
      // Listing always finds the rule
      return 'udp dpt:5353 udp spt:5353 192.168.0.0/16 udp dpt:123'
    })
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables('/custom/path/iptables')
    expect(result.ok).toBe(true)
    // No `which` call should have happened in this run
    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c.includes('which iptables'))).toBe(false)
    expect(calls.some(c => c.startsWith('/custom/path/iptables -L'))).toBe(true)
  })

  it('falls back to known POD_CAPS paths when which fails and a candidate is executable', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('which: not found', 127)
      if (cmd.startsWith('test -x ')) {
        // First candidate matches (/sbin/iptables)
        if (cmd.includes('/sbin/iptables')) return ''
        throw unavailableError('not found', 1)
      }
      // Listing returns rule presence
      return 'udp dpt:5353 udp spt:5353 192.168.0.0/16 udp dpt:123'
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)

    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c === 'which iptables 2>/dev/null')).toBe(true)
    expect(calls.some(c => c.startsWith('test -x /sbin/iptables'))).toBe(true)
    expect(calls.some(c => c.startsWith('/sbin/iptables -L'))).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith('test -x /sbin/iptables', { timeout: 2000 })
  })

  it('falls back to bare "iptables" when which fails and no candidate is executable', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('which: not found', 127)
      if (cmd.startsWith('test -x ')) throw unavailableError('not found', 1)
      // Listing — return empty so rules are seen as missing (not assumed-ok via unavailable)
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c.startsWith('iptables -L INPUT'))).toBe(true)
    expect(calls.some(c => c.startsWith('iptables -L OUTPUT'))).toBe(true)
    // All rules missing → ok=false
    expect(result.ok).toBe(false)
    expect(result.rules.every(r => r.present === false)).toBe(true)
  })
})

describe('iptablesCheck — checkIptables rule classification', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  it('marks each rule present when listing output contains its check token', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-L INPUT')) return 'udp dpt:5353 192.168.0.0/16'
      if (cmd.includes('-L OUTPUT')) return 'udp dpt:5353 udp spt:5353 udp dpt:123'
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.rules.find(r => r.name === 'LAN access (192.168.0.0/16)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'NTP outbound (UDP 123)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'mDNS outbound source (UDP 5353)')?.present).toBe(true)
  })

  it('marks rule absent when listing output omits the token (and is reachable)', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-L INPUT')) return '' // no INPUT rules
      if (cmd.includes('-L OUTPUT')) return 'udp dpt:5353 udp spt:5353 udp dpt:123'
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    const lan = result.rules.find(r => r.name === 'LAN access (192.168.0.0/16)')
    const inboundMdns = result.rules.find(r => r.name === 'mDNS inbound (UDP 5353)')
    expect(lan?.present).toBe(false)
    expect(inboundMdns?.present).toBe(false)
  })

  it('treats Permission denied / Operation not permitted from listing as "assume ok"', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L')) {
        throw unavailableError('iptables v1.8.7: Permission denied (you must be root)')
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.rules.every(r => r.present)).toBe(true)
  })

  it('treats unknown listing failures as rule-missing and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L')) {
        // status=2 is "other error" in iptables: not in the assumed-ok list
        throw unavailableError('iptables: kernel module xt_udp not loaded', 2)
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.rules.every(r => r.present === false)).toBe(true)
    expect(warnSpy).toHaveBeenCalled()
    const msgs = warnSpy.mock.calls.map(c => String(c[0]))
    expect(msgs.some(m => m.includes('Failed to check'))).toBe(true)
    warnSpy.mockRestore()
  })

  it('treats exit code 3 / 4 from listing as "assume ok"', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L')) {
        throw unavailableError('chain not found', 3)
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
  })

  it.each([
    [unavailableError('binary not found')],
    [unavailableError('spawn ENOENT')],
    [unavailableError('No such file')],
    [unavailableError('Permission denied')],
    [unavailableError('Operation not permitted')],
    [unavailableError('exit 127', 127)],
    [unavailableError('exit 3', 3)],
    [unavailableError('exit 4', 4)],
  ])('independently recognises unavailable listing error %#', async (failure) => {
    setExecHandler(({ cmd, options }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L')) {
        expect(options).toEqual({ encoding: 'utf-8', timeout: 5000 })
        throw failure
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables()).toEqual(expect.objectContaining({
      ok: true,
      repaired: [],
      rules: expect.arrayContaining([expect.objectContaining({ present: true })]),
    }))
  })

  it.each([null, 'raw failure'])('handles non-Error listing failure %j without throwing', async (failure) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L')) throw failure
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const status = checkIptables()

    expect(status.ok).toBe(false)
    expect(status.rules.every(rule => !rule.present)).toBe(true)
    expect(warn).toHaveBeenCalledWith('[iptables] Failed to check mDNS outbound (UDP 5353): ')
    warn.mockRestore()
  })
})

describe('iptablesCheck — checkAndRepairIptables', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns repaired=[] when all rules are already present', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-L INPUT')) return 'udp dpt:5353 192.168.0.0/16'
      if (cmd.includes('-L OUTPUT')) return 'udp dpt:5353 udp spt:5353 udp dpt:123'
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual([])
  })

  it('repairs missing rules and persists via iptables-save', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const repaired: string[] = []
    let savedRules = false

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      // Missing: LAN access; rest present
      if (cmd.startsWith('/sbin/iptables -L INPUT')) return 'udp dpt:5353' // omits 192.168.0.0/16
      if (cmd.startsWith('/sbin/iptables -L OUTPUT')) return 'udp dpt:5353 udp spt:5353 udp dpt:123'
      // Repair invocation
      if (cmd.includes('-A INPUT -s 192.168.0.0/16')) {
        repaired.push(cmd)
        return ''
      }
      // Persist
      if (cmd.startsWith('/sbin/iptables-save')) {
        savedRules = true
        return ''
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    expect(repaired.length).toBe(1)
    expect(savedRules).toBe(true)
    expect(logSpy).toHaveBeenCalled()
    const messages = logSpy.mock.calls.map(c => String(c[0]))
    expect(messages.some(m => m.includes('Repaired missing rule'))).toBe(true)
    expect(messages.some(m => m.includes('Saved 1 repaired rules'))).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith(
      '/sbin/iptables -A INPUT -s 192.168.0.0/16 -j ACCEPT',
      { encoding: 'utf-8', timeout: 5000 },
    )
    expect(execSyncMock).toHaveBeenCalledWith(
      '/sbin/iptables-save > /etc/iptables/rules.v4',
      { encoding: 'utf-8', timeout: 5000 },
    )
    logSpy.mockRestore()
  })

  it('logs an error and continues when a repair invocation fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L INPUT')) return ''
      if (cmd.startsWith('/sbin/iptables -L OUTPUT')) return ''
      // Every repair fails
      if (cmd.includes('-I OUTPUT') || cmd.includes('-I INPUT') || cmd.includes('-A INPUT')) {
        throw unavailableError('iptables: not permitted', 4)
      }
      // No persist call expected since repaired list is empty
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired).toEqual([])
    expect(errSpy).toHaveBeenCalled()
    const errMsgs = errSpy.mock.calls.map(c => String(c[0]))
    expect(errMsgs.some(m => m.includes('Failed to repair rule'))).toBe(true)

    // No "Saved N repaired rules" log when nothing was repaired
    const logMsgs = logSpy.mock.calls.map(c => String(c[0]))
    expect(logMsgs.some(m => m.includes('Saved'))).toBe(false)

    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('warns when persisting via iptables-save fails after a successful repair', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -L INPUT')) return 'udp dpt:5353' // missing LAN
      if (cmd.startsWith('/sbin/iptables -L OUTPUT')) return 'udp dpt:5353 udp spt:5353 udp dpt:123'
      if (cmd.includes('-A INPUT -s 192.168.0.0/16')) return ''
      if (cmd.startsWith('/sbin/iptables-save')) {
        throw unavailableError('No such file or directory: /etc/iptables/rules.v4')
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    const warnMsgs = warnSpy.mock.calls.map(c => String(c[0]))
    expect(warnMsgs.some(m => m.includes('Failed to persist rules'))).toBe(true)

    logSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('derives iptables-save path from the resolved iptables path', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let saveCmd = ''

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('not found', 1)
      if (cmd.startsWith('test -x ')) {
        if (cmd.includes('/usr/sbin/iptables')) return ''
        throw unavailableError('not found', 1)
      }
      if (cmd.startsWith('/usr/sbin/iptables -L INPUT')) return ''
      if (cmd.startsWith('/usr/sbin/iptables -L OUTPUT')) return ''
      // Repairs succeed
      if (cmd.includes('-I ') || cmd.includes('-A ')) return ''
      if (cmd.includes('iptables-save')) {
        saveCmd = cmd
        return ''
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.repaired.length).toBeGreaterThan(0)
    expect(saveCmd.startsWith('/usr/sbin/iptables-save > /etc/iptables/rules.v4')).toBe(true)
    logSpy.mockRestore()
  })

  it('replaces only the final iptables path component when deriving iptables-save', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const commands: string[] = []
    setExecHandler(({ cmd }) => {
      commands.push(cmd)
      if (cmd.includes(' -L INPUT')) return 'udp dpt:5353'
      if (cmd.includes(' -L OUTPUT')) return 'udp dpt:5353 udp spt:5353 udp dpt:123'
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const status = checkAndRepairIptables('/opt/iptables-tools/iptables')

    expect(status.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    expect(commands).toContain('/opt/iptables-tools/iptables-save > /etc/iptables/rules.v4')
    log.mockRestore()
  })
})
