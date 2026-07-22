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

const OPEN_OUTPUT = '-P OUTPUT ACCEPT\n'
const LOCAL_ONLY_OUTPUT = '-P OUTPUT ACCEPT\n-A OUTPUT -j DROP\n'
const ORIGINAL_IPV6_SYSCTL_ROOT = process.env.SLEEPYPOD_IPV6_SYSCTL_ROOT

beforeEach(() => {
  // Most unit cases model firmware with no IPv6 kernel family. Individual
  // tests opt into an existing path when exercising toolchain enforcement.
  process.env.SLEEPYPOD_IPV6_SYSCTL_ROOT = '/__sleepypod_test_no_ipv6__'
})

afterEach(() => {
  if (ORIGINAL_IPV6_SYSCTL_ROOT === undefined) {
    delete process.env.SLEEPYPOD_IPV6_SYSCTL_ROOT
  }
  else {
    process.env.SLEEPYPOD_IPV6_SYSCTL_ROOT = ORIGINAL_IPV6_SYSCTL_ROOT
  }
})

function missingRule(): Error {
  return unavailableError('iptables: Bad rule (does a matching rule exist?)', 1)
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
      if (cmd.includes(' -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      return '' // every exact `-C` rule check succeeds
    })
    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables('/custom/path/iptables')
    expect(result.ok).toBe(true)
    // No `which` call should have happened in this run
    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c.includes('which iptables'))).toBe(false)
    expect(calls.some(c => c.startsWith('/custom/path/iptables -S OUTPUT'))).toBe(true)
    expect(calls.some(c => c.startsWith('/custom/path/iptables -C'))).toBe(true)
  })

  it('falls back to known POD_CAPS paths when which fails and a candidate is executable', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('which: not found', 127)
      if (cmd.startsWith('test -x ')) {
        // First candidate matches (/sbin/iptables)
        if (cmd.includes('/sbin/iptables')) return ''
        throw unavailableError('not found', 1)
      }
      if (cmd.includes(' -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      return '' // every exact `-C` rule check succeeds
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)

    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c === 'which iptables 2>/dev/null')).toBe(true)
    expect(calls.some(c => c.startsWith('test -x /sbin/iptables'))).toBe(true)
    expect(calls.some(c => c.startsWith('/sbin/iptables -S OUTPUT'))).toBe(true)
    expect(calls.some(c => c.startsWith('/sbin/iptables -C'))).toBe(true)
    expect(execSyncMock).toHaveBeenCalledWith('test -x /sbin/iptables', { timeout: 2000 })
  })

  it('falls back to bare "iptables" when which fails and no candidate is executable', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) throw unavailableError('which: not found', 127)
      if (cmd.startsWith('test -x ')) throw unavailableError('not found', 1)
      if (cmd.includes(' -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd.includes(' -C ')) throw missingRule()
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    const calls = execSyncMock.mock.calls.map(c => String(c[0]))
    expect(calls.some(c => c.startsWith('iptables -S OUTPUT'))).toBe(true)
    expect(calls.some(c => c.startsWith('iptables -C INPUT'))).toBe(true)
    expect(calls.some(c => c.startsWith('iptables -C OUTPUT'))).toBe(true)
    // All rules missing → ok=false
    expect(result.ok).toBe(false)
    expect(result.rules.every(r => r.present === false)).toBe(true)
  })
})

describe('iptablesCheck — checkIptables rule classification', () => {
  beforeEach(() => {
    execSyncMock.mockReset()
  })

  it('marks each rule present only when its exact ACCEPT rule exists', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) return LOCAL_ONLY_OUTPUT
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.rules.find(r => r.name === 'LAN access (192.168.0.0/16)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'NTP outbound (UDP 123)')?.present).toBe(true)
    expect(result.rules.find(r => r.name === 'mDNS outbound source (UDP 5353)')?.present).toBe(true)
  })

  it('marks exact rules absent even when a similarly shaped DROP exists', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd.includes('-C INPUT -p udp') || cmd.includes('-C INPUT -s 192.168.0.0/16')) {
        throw missingRule()
      }
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

  it('treats an intentionally open firewall as healthy without explicit exceptions', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) return OPEN_OUTPUT
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(true)
    expect(result.rules.every(rule => rule.present)).toBe(true)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).includes(' -C '))).toBe(false)
  })

  it('recognises the legacy SLEEPYPOD-BLOCK jump as Local Only', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) {
        return '-P OUTPUT ACCEPT\n-A OUTPUT -j SLEEPYPOD-BLOCK\n'
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().ok).toBe(true)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).includes(' -C '))).toBe(true)
  })

  it('does not mistake an ACCEPT policy with a narrow DROP for Local Only', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) {
        return '-P OUTPUT ACCEPT\n-A OUTPUT -p tcp --dport 443 -j DROP\n'
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().ok).toBe(true)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).includes(' -C '))).toBe(false)
  })

  it('does not mistake an unconditional LOG target for Local Only', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) {
        return '-P OUTPUT ACCEPT\n-A OUTPUT -j LOG\n'
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().ok).toBe(true)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).includes(' -C '))).toBe(false)
  })

  it('does not classify malformed successful mode output as intentionally open', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.includes('-S OUTPUT')) return ''
      if (cmd.includes(' -C ')) throw missingRule()
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    expect(checkIptables().ok).toBe(false)
  })

  it('reports a partial IPv6 toolchain as degraded without repair looping', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.SLEEPYPOD_IPV6_SYSCTL_ROOT = process.cwd()
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd === 'test -x /sbin/ip6tables') return ''
      if (cmd === 'test -x /sbin/ip6tables-save') throw unavailableError('not found', 1)
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()

    expect(result.ok).toBe(false)
    expect(result.repairable).toBe(false)
    expect(result.rules).toContainEqual(expect.objectContaining({
      name: 'IPv6 firewall toolchain',
      present: false,
      critical: true,
    }))
    expect(execSyncMock.mock.calls.some(call => String(call[0]).startsWith('sudo '))).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      '[iptables] Skipping automatic repair because firewall inspection was inconclusive',
    )
    warn.mockRestore()
  })

  it('ignores stray IPv6 userspace tools when the kernel family is absent', async () => {
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('test -x /sbin/ip6tables')) return ''
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()

    expect(result.ok).toBe(true)
    expect(result.rules.some(rule => rule.name.startsWith('IPv6'))).toBe(false)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).startsWith('test -x /sbin/ip6tables'))).toBe(false)
  })

  it('reports installed-but-unreadable iptables as degraded and not repairable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -')) {
        throw unavailableError('iptables v1.8.7: Permission denied (you must be root)')
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.ok).toBe(false)
    expect(result.repairable).toBe(false)
    expect(result.rules.every(r => !r.present)).toBe(true)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).startsWith('sudo '))).toBe(false)
    warn.mockRestore()
  })

  it('does not treat a status-1 permission failure as a missing rule', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -')) {
        throw unavailableError('iptables: Permission denied (you must be root)', 1)
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.repairable).toBe(false)
    expect(result.rules.every(r => !r.present)).toBe(true)
    warn.mockRestore()
  })

  it('treats unknown listing failures as rule-missing and warns', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -')) {
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

  it('treats exit code 3 / 4 as inconclusive instead of healthy', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -')) {
        throw unavailableError('chain not found', 3)
      }
      return ''
    })

    const { checkIptables } = await import('../iptablesCheck')
    const result = checkIptables()
    expect(result.ok).toBe(false)
    expect(result.repairable).toBe(false)
    warn.mockRestore()
  })

  it.each([
    [Object.assign(unavailableError('spawn failed'), { code: 'ENOENT' })],
    [unavailableError('exit 127', 127)],
  ])('independently recognises absent executable error %#', async (failure) => {
    setExecHandler(({ cmd, options }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -')) {
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
      if (cmd.startsWith('/sbin/iptables -')) throw failure
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
      if (cmd.includes('-S OUTPUT')) return LOCAL_ONLY_OUTPUT
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual([])
    expect(execSyncMock.mock.calls.some(call => String(call[0]).startsWith('sudo '))).toBe(false)
  })

  it('re-applies and verifies the root-owned Local Only policy', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let policyReapplied = false

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd === 'sudo -n /usr/local/bin/sp-update --internet-access block') {
        policyReapplied = true
        return ''
      }
      if (!policyReapplied && cmd.startsWith('/sbin/iptables -C INPUT -s 192.168.0.0/16')) {
        throw missingRule()
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()

    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    expect(execSyncMock).toHaveBeenCalledWith(
      'sudo -n /usr/local/bin/sp-update --internet-access block',
      { encoding: 'utf-8', timeout: 30_000 },
    )
    expect(logSpy).toHaveBeenCalledWith(
      '[iptables] Repaired Local Only policy: LAN access (192.168.0.0/16)',
    )
    logSpy.mockRestore()
  })

  it('does not mutate the firewall after an ambiguous status-1 inspection failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd.includes(' -C ')) throw unavailableError('iptables exited unsuccessfully', 1)
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()

    expect(result.ok).toBe(false)
    expect(result.repairable).toBe(false)
    expect(execSyncMock.mock.calls.some(call => String(call[0]).startsWith('sudo '))).toBe(false)
    expect(warnSpy).toHaveBeenCalledWith(
      '[iptables] Skipping automatic repair because firewall inspection was inconclusive',
    )
    warnSpy.mockRestore()
  })

  it('repairs an open IPv6 egress path when Local Only is active', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let policyReapplied = false
    process.env.SLEEPYPOD_IPV6_SYSCTL_ROOT = process.cwd()

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd === 'sudo -n /usr/local/bin/sp-update --internet-access block') {
        policyReapplied = true
        return ''
      }
      if (!policyReapplied && cmd === '/sbin/ip6tables -C OUTPUT -j DROP') {
        throw missingRule()
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()

    expect(result.ok).toBe(true)
    expect(result.repaired).toEqual(['IPv6 WAN block'])
    expect(execSyncMock).toHaveBeenCalledWith(
      'sudo -n /usr/local/bin/sp-update --internet-access block',
      { encoding: 'utf-8', timeout: 30_000 },
    )
    logSpy.mockRestore()
  })

  it('checks the same multicast-scoped mDNS rule installed by the helper', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let policyReapplied = false
    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd === 'sudo -n /usr/local/bin/sp-update --internet-access block') {
        policyReapplied = true
        return ''
      }
      if (!policyReapplied
        && cmd.startsWith('/sbin/iptables -C OUTPUT -p udp -d 224.0.0.251/32 --sport 5353')) {
        throw missingRule()
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()

    expect(result.repaired).toEqual(['mDNS outbound source (UDP 5353)'])
    expect(execSyncMock.mock.calls.some(call => String(call[0])
      .startsWith('/sbin/iptables -C OUTPUT -p udp -d 224.0.0.251/32 --sport 5353 -j ACCEPT'))).toBe(true)
    logSpy.mockRestore()
  })

  it('returns the original degraded state when the root helper fails', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = unavailableError('sudo: a password is required', 1)

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd.includes(' -C ')) throw missingRule()
      if (cmd.startsWith('sudo -n ')) throw failure
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.ok).toBe(false)
    expect(result.repaired).toEqual([])
    expect(errSpy).toHaveBeenCalledWith('[iptables] Failed to repair Local Only policy:', failure)
    errSpy.mockRestore()
  })

  it('reports degraded when post-helper verification still finds a missing rule', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    setExecHandler(({ cmd }) => {
      if (cmd.includes('which iptables')) return '/sbin/iptables\n'
      if (cmd.startsWith('/sbin/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd.startsWith('/sbin/iptables -C INPUT -s 192.168.0.0/16')) throw missingRule()
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const result = checkAndRepairIptables()
    expect(result.ok).toBe(false)
    expect(result.repaired).toEqual([])

    logSpy.mockRestore()
  })

  it('uses the resolved override for checks but the fixed privileged dispatcher for repair', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    let policyReapplied = false

    setExecHandler(({ cmd }) => {
      if (cmd.startsWith('/opt/iptables-tools/iptables -S OUTPUT')) return LOCAL_ONLY_OUTPUT
      if (cmd === 'sudo -n /usr/local/bin/sp-update --internet-access block') {
        policyReapplied = true
        return ''
      }
      if (!policyReapplied && cmd.startsWith('/opt/iptables-tools/iptables -C INPUT -s 192.168.0.0/16')) {
        throw missingRule()
      }
      return ''
    })

    const { checkAndRepairIptables } = await import('../iptablesCheck')
    const status = checkAndRepairIptables('/opt/iptables-tools/iptables')

    expect(status.ok).toBe(true)
    expect(status.repaired).toEqual(['LAN access (192.168.0.0/16)'])
    expect(execSyncMock.mock.calls.some(call => String(call[0])
      .startsWith('/opt/iptables-tools/iptables -C '))).toBe(true)
    expect(execSyncMock.mock.calls.some(call => String(call[0])
      .startsWith('sudo -n /usr/local/bin/sp-update'))).toBe(true)
    logSpy.mockRestore()
  })
})
